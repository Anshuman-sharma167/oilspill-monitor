# Progress log

## 2026-10-01 — Part 6: AOIs and quota priority

- Added the versioned western-coast pilot AOI dataset, clipped to a Natural
  Earth water mask; shared AOI contract fields and local geometry checks;
  PostGIS AOI, monthly-credit-policy, and coverage-gap tables; 60/20/20 quota
  allocation with P2 deferral at 80%; versioned catalogue-query selection; and
  coverage-gap status output.
- Changed `.gitignore`, `data/aois.geojson`, the shared schema and generated
  Python/TypeScript models and validators, `packages/geo`, the dashboard status
  boundary, the Part 6 migration, contract fixtures, `package.json`, and focused
  Part 6 tests.
- Checks: `npm run test:part6` PASS (7/7); `npm run test:contracts` PASS (10
  TypeScript and 2 Python); generation, type, lint, SQL-format, and diff checks
  PASS; Codex Security diff scan PASS with complete coverage and no findings;
  `npm run check` PASS (54 TypeScript tests and 2 Python tests, plus formatting,
  lint, typing, sample, mock integration, configuration, container, and
  repository-scan gates).
- Delivery: committed as `bb9f210` on `part-6-aoi-quota` and opened as GitHub
  pull request #4. All GitHub checks passed and the pull request reports a
  clean, mergeable state.
- Remaining limitations: the pilot stays disabled until an authenticated openEO
  provider estimate supplies an approximate credit cost. PostGIS checks are
  present in the migration but were not runtime-tested because no local PostGIS
  service was available.

## 2026-10-01 — Part 7: CDSE access and credit accounting

- Added server-only CDSE client configuration, typed authentication and provider
  errors, expiring token cache, bounded STAC and openEO requests, a sanitized
  Sentinel-1 GRD fixture, VV/VH validation, and a tiny versioned job graph.
  Added usage caching, fail-closed quota decisions, durable reservation and
  provider-job state, credit ledger, coverage-gap handling, and operations and
  provider-source notes. Part 8 was not changed.
- Changed `.env.example`, `packages/config`, the shared schema and generated
  TypeScript/Python models and validators, `services/worker/src/part7*.ts`,
  `supabase/migrations/20261001100000_part7_cdse_accounting.sql`, Part 7
  fixtures and tests, `package.json`, and Part 7 operations documentation. The
  migration adds private usage snapshots, reviewer releases, provider runs,
  dispatch decisions, and an append-only credit ledger. It extends the Part 5
  failure codes and links Part 7 work to coverage gaps.
- Verification: focused Part 7 tests PASS (10/10), including persistent P2
  deferral at the 80% threshold, replay-safe submission and ledger entries,
  rejection of worker-written reviewer releases, and reopening a failed-job gap.
  Part 5/6 and contract checks PASS; full `npm run check` PASS (64 TypeScript
  and 2 Python tests, formatting, lint, typing, sample, mock integration,
  configuration, container, and repository scan). Full PostGIS runtime migration
  check SKIPPED because the Docker daemon is unavailable.
- Live evidence: authenticated token and account access PASS; CDSE STAC search
  PASS for one Sentinel-1 GRD scene with VV/VH; openEO collection metadata PASS
  for VV/VH. The versioned tiny openEO job finished on 2 October 2026. CDSE
  reported 4 billed credits and the result asset reported 31,755 bytes. The
  sanitized evidence contains timestamps and IDs but no token, secret, account
  identity, signed URL, or raster. `GET /me` did not expose monthly allowance or
  usage, so P2 continues to fail closed.
- Security: initial Codex Security working-tree diff scan reviewed 11 changed
  source files and found one medium reviewer-release authorization issue and one
  low coverage-gap audit issue. Both were fixed; the STAC sanitizer was
  tightened. The completed rescan reviewed the same 11 changed source files with
  complete source coverage and zero findings. No secrets were found by the
  repository scan. Production reviewer-role grants remain unverified.
- Exit gate: **PASSED**. One versioned openEO job ran end to end with recorded
  timestamps, 4 provider-reported credits, and a 31,755-byte output. Focused
  tests persist `deferred_quota` under forced quota exhaustion, and the full
  repository scan found no secret. No paid resources were activated. The Part 6
  recurring pilot remains disabled, and deploying the migration to a Supabase
  project remains an environment step because this checkout has no linked
  project or database credentials.

## 2026-10-03 — Part 8: reliable Sentinel-1 STAC discovery

- Added protected 15-minute Supabase discovery, a 60-minute overlapping CDSE
  STAC search with bounded retries and pagination, normalized scene metadata,
  explicit missing-VH handling, and atomic PostGIS scene/AOI/job persistence.
  Scene identity now includes provider, collection, and provider item ID.
- Changed the discovery service, shared contracts and identities, server-only
  configuration, Part 7 callers, a forward-only Part 8 migration and Edge
  Function, synthetic fixtures, operations documentation, and focused tests.
- Verification: `npm run test:part8` PASS (14/14); `npm run check` PASS (81
  TypeScript and 2 Python tests plus all quality, integration, configuration,
  container, and repository-scan gates); dependency audits PASS with no known
  Node or Python vulnerabilities.
- Security: the initial Codex Security diff scan found one medium unbounded
  provider-response/geometry issue. Streamed body and geometry-complexity limits
  were added with regression coverage; the final complete rescan found zero
  findings.
- Exit gate: **PASSED** against real PostgreSQL/PostGIS WASM. Ten identical
  polls produced one scene, two jobs for the two positive-area AOI overlaps, no
  duplicate logical identity, ten poll rows, preserved first-discovery time,
  advanced last-discovery time, and no reset of an existing queued job.
- Hosted verification: migrations are applied to the healthy Supabase project,
  the JWT-protected Edge Function is active, all three named Vault values are
  present, and exactly one active `*/15 * * * *` Cron job uses Vault lookups
  without embedding decrypted values. A protected invocation returned `200` and
  recorded a successful zero-AOI poll with no provider request or created work.
- Remaining limitation: the recurring Part 6 pilot AOI remains disabled because
  its authenticated openEO credit estimate is still pending. Scheduled Part 8
  polls therefore remain safe no-op runs until that separate gate is satisfied.

## 2026-10-04 — Part 9: idempotent PostgreSQL job queue

- **PASS — implementation:** added one forward-only Part 9 migration with
  priority-aware `FOR UPDATE SKIP LOCKED` claiming, bounded attempts and leases,
  database-enforced transitions, state-bound SHA-256 checkpoints, guarded lease
  recovery, audited human requeue, and provider-job-ID consistency. Added the
  injectable synthetic worker, recovery and database boundaries, plus a GitHub
  App dispatcher and a fail-closed one-job workflow. No Part 10 processing,
  inference, scoring, review UI, or alert delivery was added.
- **PASS — focused and full checks:** `npm run test:part9` passed 7/7. The final
  `npm run check` passed 88/88 TypeScript tests and 2/2 Python tests plus all
  formatting, lint, typing, sample, mock integration, configuration, container,
  and repository-scan gates. `git diff --check` passed. Node and Python audits
  reported no known vulnerabilities.
- **PASS — real PostgreSQL exit gate:** the migration was applied to the
  existing healthy Supabase project. Eighteen concurrent hosted SQL claim calls
  competed for six synthetic queued jobs; all six jobs entered preprocessing
  with six distinct claimers and no duplicate ownership. Hosted crash
  simulations after claim, after durable provider submission, and after asset
  checkpoint all passed. Recovery preserved one provider run, reused one
  immutable checkpoint, and created no candidates or alerts. Persistent
  synthetic claim rows were deleted and the crash fixtures were rolled back;
  verification found zero remaining synthetic rows.
- **PASS — access controls and security:** hosted metadata confirmed the claim
  index, checkpoint and requeue tables, claim and recovery functions, and denied
  claim execution to `anon` and `authenticated`. The final Codex Security diff
  scan reviewed all 13 changed source surfaces with complete coverage and zero
  reportable findings. Repository scanning checked 135 current files and 205
  reachable committed blobs.
- **PASS — hosted database:** the Part 9 migration and a rollback-only synthetic
  claim/checkpoint/completion flow succeeded. Supabase security advisors report
  only informational no-policy notices for the deliberately deny-by-default
  private tables. Performance advisors report informational existing unindexed
  foreign keys, including the new requeue audit foreign key; no index was added
  without an observed workload need.
- **BLOCKED — live GitHub dispatch:** static workflow and dispatcher tests pass,
  the only caller input is `job_id`, actions are commit-pinned, permissions are
  minimal, and authorization uses a short-lived GitHub App/OIDC design. The
  repository has no Part 9 Actions variables or secrets configured, so live
  dispatch remains disabled and no synthetic workflow was sent.
- Delivery is on `codex/part-9-postgres-queue`, based on the merged Part 8
  commit on `origin/main`. The pull request is intentionally not merged.
