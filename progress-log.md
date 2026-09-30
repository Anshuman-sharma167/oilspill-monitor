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
- Remaining limitations: the pilot stays disabled until an authenticated openEO
  provider estimate supplies an approximate credit cost. PostGIS checks are
  present in the migration but were not runtime-tested because no local PostGIS
  service was available.
