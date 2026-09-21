# Contributing

## Local setup

Use Node.js 22 and install exactly from the lockfile with `npm ci`. Run
`npm run check` before opening a pull request. The individual checks are
documented in the README.

Keep changes within the current implementation part. Empty provider directories
are boundaries, not permission to configure services.

## Data and evidence rules

Do not commit operational coordinates, raw or derived satellite products,
private candidate records, reviewer evidence, candidate or reviewer exports,
credentials, signed URLs, model weights, checkpoints, masks, or review imagery.
Do not copy material from a private or historical project into this repository.

Only small fixtures that were deliberately created as synthetic and confirmed
redistributable may be added under `data/fixtures`. Describe the fixture's
synthetic origin and licence in the same change.

Use candidate-monitor terminology. Do not describe a model result as a confirmed
oil spill, official ground truth, vessel attribution, legal conclusion, or
automatic final decision. Preserve uncertain status until a human review
supports a different label.

## Changes and review

Add tests for behavior changes. Document provider or model choices as decision
records before implementation. Report security issues through the private
process in SECURITY.md, not a public issue.
