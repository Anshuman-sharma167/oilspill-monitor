# oilspill-monitor

`oilspill-monitor` is a private-data, human-reviewed Sentinel-1 oil-like slick
candidate monitor. This repository contains only the public code scaffold. It
does not confirm oil spills, make automatic final decisions, attribute
observations to vessels, establish official ground truth, or support legal
conclusions.

The intended workflow presents possible oil-like slick candidates for manual
review. Reviewers may classify observations as likely slick, look-alike, or
uncertain and assign a review priority. Human approval is mandatory before any
external alert or conclusion.

## Scope and exclusions

This Part 3 scaffold provides shared TypeScript types, a deterministic sample
command, local quality checks, documentation, and continuous-integration
definitions. It does not implement the dashboard, scene discovery, worker
processing, database, openEO access, Cloudflare R2 storage, model downloads,
deployment, or production services.

Only original project code is licensed under Apache-2.0. Datasets, satellite
products, external models, and trained weights are excluded from this repository
and may have separate licences and use restrictions. No operational coordinates,
reviewer evidence, candidate exports, credentials, signed URLs, private imagery,
checkpoints, or generated artifacts may be committed.

## Public code and private data

Public source code and synthetic fixtures belong in this repository. Operational
inputs and human-review records must remain in access-controlled systems outside
Git. Files under `data/fixtures` must be deliberately created, synthetic, small,
and redistributable. A fixture must not be derived from a private scene,
coordinate, reviewer record, or historical baseline.

## Setup

Install Node.js 22 and dependencies from the committed lockfile:

```console
npm ci
```

Run the deterministic sample, which needs no network access, credentials,
coordinates, external data, or model weights:

```console
npm run sample
```

Run every local validation:

```console
npm run check
```

Individual commands are `npm run format:check`, `npm run lint`,
`npm run typecheck`, `npm test`, `npm run sample`, and `npm run scan:repo`.

## Directory structure

```text
apps/dashboard/          Dashboard boundary; no dashboard implementation yet
services/discovery/      Scene-discovery boundary; no external queries yet
services/worker/         Processing boundary; no inference pipeline yet
packages/schemas/        Shared candidate types and normalization
packages/geo/            Non-operational geographic utilities
models/registry/         Documentation and checksums only; no model weights
data/fixtures/           Synthetic, redistributable fixtures only
supabase/                 Reserved boundaries; no configured project or schema
infra/                    CI and provider notes; no deployment configuration
tests/                    Unit, integration, and end-to-end test boundaries
docs/                     Architecture, operations, cards, and decisions
scripts/                  Deterministic local commands
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before making changes and
[DISCLAIMER.md](DISCLAIMER.md) for operating limits.
