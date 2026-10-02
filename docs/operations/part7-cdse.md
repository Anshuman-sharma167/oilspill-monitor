# Part 7 CDSE access and quota operations

This procedure covers the core CDSE openEO service and the CDSE STAC catalogue.
The pilot AOI remains disabled until a provider cost estimate is recorded under
the Part 6 enablement rule. Part 7 has no recurring scene discovery or automatic
scheduling.

## Account and secrets

Request a dedicated project service account and application client through the
[CDSE help center procedure](https://documentation.dataspace.copernicus.eu/APIs/openEO/authentication/client_credentials.html).
Do not reuse a developer's unrelated personal client. Enable multi-factor
authentication on the human CDSE account following the
[CDSE guide](https://documentation.dataspace.copernicus.eu/2FA.html). The
account request, MFA enrollment, credit-balance linkage, and issuance of
credentials are manual actions; none is implied by this repository.
Service-account jobs and credits are separate from a personal account until CDSE
support links them. The token request includes the `openid email` scopes
required by the CDSE openEO OIDC provider.

Set `CDSE_CLIENT_ID` and `CDSE_CLIENT_SECRET` only in an ignored local
environment file or the approved server secret store. `.env.example` lists names
only. Rotate a compromised or expired application secret at CDSE, replace it in
the server store, restart the worker, and perform a non-logging token check. Do
not paste a secret or token into PowerShell history, an issue, a log, a
screenshot, or `progress-log.md`. Missing required names raise
`MissingServerConfigError`; authentication rejection or lockout is a named
`ProviderError` and stops dispatch. In-memory tokens expire according to
`expires_in`, with a configurable safety window. No raw token is persisted.

Optional names are `CDSE_COLLECTION_ID`, `CDSE_VV_BAND`, `CDSE_VH_BAND`,
`CDSE_TOKEN_SAFETY_MS`, `CDSE_USAGE_CACHE_MS`, `CDSE_FREE_CREDIT_REFERENCE`, and
`CDSE_DISPATCH_ENABLED`. Invalid values raise `Part7ConfigError`. The defaults
are collection `SENTINEL1_GRD`, VV/VH, 30 seconds, five minutes, 10,000
reference credits, and dispatch disabled. The 10,000 value is a planning
reference from the
[CDSE credit guide](https://documentation.dataspace.copernicus.eu/APIs/openEO/credit_usage.html),
not a verified current allowance. Keep `CDSE_DISPATCH_ENABLED=false` to stop
provider submission without deleting queued or deferred work. Do not configure
paid plans or organization options for the verification job.

## Verification and dispatch

Use the existing western-coast AOI ID `aoi:western-coast-shadow-pilot` and
policy `1.0.0`. The approved tiny test area is 71.5–71.505°E, 18.1–18.105°N, on
31 January 2025. The public STAC item search returned one Sentinel-1 GRD item
with both VV and VH on 1 October 2026. The sanitized fixture is
`data/fixtures/part7/stac-sentinel1-grd-2025-01-31.sanitized.json`; it retains
only public scene ID, collection, time, and polarization names. The
corresponding public openEO collection metadata returned `SENTINEL1_GRD` with VV
and VH. Recheck both live before a real job. The fixture is offline test data
and does not establish current access.

The worker's `CdseAuth`, `CdseProvider`, `UsageCache`, and `Part7Dispatch` are
the Part 7 boundaries. Connect `Part7Dispatch` to a transaction-capable SQL
client for the private `app_private` schema; apply the Part 7 migration after
Parts 5 and 6. A job needs an existing queued `processing_jobs` row, matching
enabled AOI and priority, a stable Part 5 job ID, a recorded credit estimate,
and the versioned tiny graph. The Part 6 pilot is disabled, so an operator must
first record a genuine provider estimate and pass the Part 6 AOI enablement
gate. No local test grants that permission.

Before ordinary dispatch, fetch current service-account usage. The openEO
standard's `GET /me` may return only a remaining `budget`; it does not
standardize monthly allowance and used totals. The authenticated CDSE response
checked on 2 October 2026 contained identity information but no allowance or
used-credit values. The code accepts a snapshot only when both
`monthly_allowance` and `monthly_used` are valid provider-reported numbers; a
remaining balance alone cannot be converted using the 10,000 reference. Until an
approved provider usage source supplies both values, P2 stays `deferred_quota`.
P0/P1 require a release for the exact job from an independent human reviewer.
Record the safe reviewer ID, reason, policy version, and release time in
`app_private.reviewer_releases` through a separately authenticated reviewer
database login. A database administrator must grant that login membership in the
`part7_reviewer` role and no such membership to the worker login. The reviewer
must use `SET ROLE part7_reviewer` for the insert and set `reviewer_id` to their
login name (`session_user`). The migration enforces this role and identity check
and makes releases append-only. The worker only reads this table; its runtime
role must have no INSERT, UPDATE, or DELETE privilege. A release is single-job,
is recorded in `dispatch_decisions`, and does not activate paid resources.

For the small live job, call `reserve` first and confirm its persistent estimate
ledger entry and usage decision. Only then set the dispatch switch for the
single intended run and call `submit`, `start`, and bounded `observe` polling.
Persist the provider job ID before polling. If `submit` becomes ambiguous, stop:
its state is `ambiguous`, and a second creation request is prohibited until the
provider's job list has been reconciled by the operator. A start failure
likewise requires checking the known provider job before another start. After
`finished`, record the job's `costs` when present, its result asset sizes when
reported, and the ledger adjustment. If the provider omits either value, leave
it unavailable; never invent a charge or size. Signed result URLs must not be
copied to storage or logs. Download no archive for this verification.

The private ledger stores estimate, actual, adjustment, and release facts as
append-only entries. The dispatcher locks the monthly policy row while reserving
and includes active reservations and terminal costs newer than the usage
snapshot in projected use. Its 60/20/20 buckets and P2 80% threshold follow
Part 6. Reconsider a deferred job with `reconsider` after fresh usage is
available or a valid P0/P1 reviewer release has been recorded. This preserves
its decision history and closes, rather than deletes, its coverage-gap interval.
Review `app_private.coverage_gaps` and `app_private.dispatch_decisions` for
missing coverage and decisions.

## Failures and recovery

Authentication rejection, expired credentials, and account lockout stop
requests. Rotate credentials or resolve the account with CDSE support before
retrying. A rate limit reports `RATE_LIMITED` and a bounded `Retry-After`; wait
at least that long. On token, STAC, openEO, or usage outage, leave work queued
or deferred and investigate service status. The client has timeouts and does not
automatically repeat billable `POST /jobs`. When the usage endpoint is
unavailable, P2 fails closed and P0/P1 wait for job-specific reviewer release.
When free credits are exhausted, defer new work; never switch to a paid option.
Check the provider account balance and job status after recovery, refresh usage,
then reconsider deferred work one job at a time.

For a cancelled or failed provider job, record the terminal state, safe reason
code, any provider-reported actual cost, and a coverage gap. Actual cost may
still exist on failure. If the actual cost exceeds or falls below the estimate,
append one signed adjustment; do not rewrite the original estimate or actual
entry. If the provider does not report an actual cost, mark it unavailable and
keep the estimate's provenance distinct. A second observation of the same
terminal event must not add another ledger entry.

Safe incident data are local job ID, provider job ID, AOI ID, policy version,
graph version, timestamps, safe error code, sanitized quota snapshot numbers,
and ledger entry IDs. Never copy authorization headers, client credentials, raw
tokens, cookies, signed asset URLs, raw provider responses, private account
identifiers, or operational coordinates outside the approved pilot. To refresh a
fixture, query only the tiny approved area and date, pass the raw response
through `sanitizeStac`, validate the sanitized object, and review the resulting
JSON for secret-bearing keys before saving it.

Source URLs and provider checks are recorded in
[the provider source note](part7-provider-sources.md). The sanitized live
evidence is in `data/fixtures/part7/openeo-live-pilot-evidence.sanitized.json`.
The versioned job finished on 2 October 2026, reported 4 credits, and produced a
31,755-byte GeoTIFF. The size came from an HTTPS metadata request to the trusted
CDSE asset host; no signed URL or raster was stored. Provider usage remains
unavailable through `GET /me`, so P2 dispatch stays fail closed and P0/P1 work
still requires an independent reviewer release.
