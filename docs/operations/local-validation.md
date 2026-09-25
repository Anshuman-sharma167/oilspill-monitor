# Local validation

Run `npm run setup` from a clean checkout and then `npm run check`. Setup uses
the committed Node and Python lockfiles and excludes training dependencies. The
check formats in read-only mode, lints, type-checks, runs unit and mock
integration tests, validates browser/server and container boundaries, and scans
the current tree and Git history for high-confidence secrets, forbidden
private-data paths and extensions, and files larger than 5 MiB.

The scan is a guardrail, not proof that a repository is safe. Review the
complete diff and Git index before each commit. Never add operational
coordinates or reviewer evidence, even if a file type is not blocked.
