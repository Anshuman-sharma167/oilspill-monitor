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
