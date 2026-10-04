# Part 9 PostgreSQL job queue

Part 9 uses `app_private.processing_jobs` as the durable queue. It does not add
Redis, a permanent queue service, SAR preprocessing, model inference, candidate
scoring, review UI, or alerts. The TypeScript handlers used by the tests are
synthetic stage boundaries.

## Admission and state rules

Discovery creates one job for
`(scene_id, aoi_id, preprocessing_version, model_version)`. Part 7 remains the
quota authority. A job is claimable only after admission has put it in `queued`;
`discovered` and `deferred_quota` are never claimable.

The migration enforces these transitions in PostgreSQL:

- `discovered -> queued` or `deferred_quota`
- `deferred_quota -> queued` after a recorded Part 7 readmission decision
- `queued -> preprocessing` through the claim function
- `preprocessing -> inferencing -> ready_for_review`
- active work may return to `queued` only with a retryable named error
- active or queued work may enter `failed`
- `failed -> queued` requires the human-requeue function and a current Part 7
  reservation; otherwise readmission is required

No Part 9 operation changes `ready_for_review`. Existing transition timestamps
are retained with `coalesce`; retries do not erase earlier timestamps.

## Claim order and leases

`app_private.claim_processing_job` validates a worker ID and a lease of 60 to
3,600 seconds. It selects `P0`, then `P1`, then `P2`, and within a priority uses
the oldest queued time followed by `job_id`. Selection uses
`FOR UPDATE SKIP LOCKED`, then changes the row to `preprocessing`, increments
`attempt_count`, creates a UUID claim token, and returns the job in the same
transaction.

The default lease is 300 seconds. Renew before expiry. Every worker mutation
requires the current claim token and an unexpired lease. A replaced or expired
worker receives `STALE_JOB_CLAIM` or a false guarded update and must stop. The
worker renews before each bounded stage.

## Checkpoints

`processing_stage_checkpoints` has one row per `(job_id, stage, stage_version)`.
Checksums are lowercase SHA-256 hex. Replaying the same checksum reuses the
marker; a different checksum raises `CORRUPTED_OUTPUT`. Metadata is small,
object-shaped, and rejects credential, signed-URL, geometry, and coordinate
terms. Store only synthetic identifiers, byte counts, media types, or similarly
non-sensitive resume facts. Preprocessing markers require a preprocessing job;
inference and asset-upload markers require an inferencing job.

## Retry and failure policy

Retryable codes are `NETWORK_TIMEOUT`, `TEMPORARY_PROVIDER_FAILURE`,
`GITHUB_TRANSIENT_FAILURE`, `TEMPORARY_STORAGE_FAILURE`, `WORKER_INTERRUPTED`,
and `PROVIDER_STATUS_UNAVAILABLE`. Permanent codes include
`UNSUPPORTED_POLARIZATION`, `INVALID_GEOMETRY`, `CONTRACT_VALIDATION_FAILED`,
`CORRUPTED_OUTPUT`, and `INVALID_CONFIGURATION`.

The worker calculates capped exponential backoff with injected randomness. The
database accepts only a 1–3,600 second delay. Attempts default to three and are
bounded at ten. Retry releases all claim fields but keeps checkpoints and the
provider ID. Exhaustion or a permanent error enters `failed` with a bounded,
sanitized visible reason.

## Recovery and provider reconciliation

Recovery selects expired active leases, then the database locks and rechecks the
exact claim token before changing a row.

- No provider ID: requeue with bounded backoff if attempts remain.
- Provider queued or running: rotate recovery ownership and keep monitoring;
  never submit another provider job.
- Provider finished: retain the provider ID and resume from durable markers.
- Provider error: apply the bounded retry policy.
- Provider canceled: fail visibly.
- Status unavailable or ambiguous: fail closed with
  `PROVIDER_STATUS_UNAVAILABLE`; do not infer that no job exists.

`provider_job_runs` remains authoritative. A trigger copies its provider ID to
`processing_jobs`, while a second trigger rejects divergent direct changes.

## Human requeue

Use `app_private.human_requeue_processing_job` only from a login that is a
member of `part9_reviewer`. The supplied reviewer ID must equal `session_user`;
application, bot, worker, and service-role identities are rejected. The reason
is mandatory and sanitized. The function writes an audit row, preserves stage
markers and immutable identity, and refuses to queue work without an eligible
Part 7 reservation.

## GitHub Actions

`.github/workflows/part9-process-job.yml` accepts exactly `job_id`. The external
dispatcher mints a one-hour GitHub App installation token with `Actions: write`
instead of using a personal token. The run has `contents: read` and
`id-token: write`, validates the job ID, and retrieves authoritative
configuration from an OIDC-protected service without printing it. Actions are
pinned to full commit SHAs and concurrency is keyed by job ID.

Live execution is deliberately disabled unless
`PART9_LIVE_DISPATCH_ENABLED=true` and the OIDC audience/configuration endpoint
are configured and verified. The checked-in runner boundary stops with
`PART9_LIVE_WORKER_NOT_CONFIGURED`; it does not fall back to a long-lived
Supabase service key.

## Diagnosis and recovery commands

Run the local deterministic suite:

```powershell
npm.cmd run test:part9
```

Run the real locking and crash gate only against an empty disposable
PostgreSQL/PostGIS database. The script applies every migration and truncates
its synthetic data:

```powershell
$env:PART9_POSTGRES_DISPOSABLE='true'
$env:PART9_POSTGRES_URL='<disposable connection URL>'
npm.cmd run test:part9:postgres
```

For a stuck job, inspect state, attempts, `next_attempt_at`, lease expiry, and
the latest sanitized error. Active leases are not recoverable. Expired leases
with a provider ID require a provider-status check. Exhausted jobs require
correction, quota readmission where needed, and a human requeue. An ambiguous
provider status stays closed until reconciliation gives a definite state.

## Privacy and current limitations

Do not log or store tokens, account identity, response bodies, private imagery,
asset URLs, AOI geometry, or coordinates. Keep `app_private` outside exposed
Data API schemas and grant no browser access.

PGlite verifies migration order, constraints, functions, deterministic claims,
fencing, checkpoints, retries, and recovery. It is not evidence for independent
PostgreSQL sessions. The real exit gate requires `psql` and a disposable
PostgreSQL/PostGIS database. Hosted migration, GitHub App dispatch, OIDC
exchange, and live provider reconciliation must be reported separately until
actually run.
