# Local validation

Run `npm ci` from a clean checkout and then `npm run check`. The check formats
in read-only mode, lints, type-checks, runs unit tests, prints the deterministic
sample, and scans repository files for high-confidence secret patterns,
forbidden private-data paths and extensions, and files larger than 5 MiB.

The scan is a guardrail, not proof that a repository is safe. Review the
complete diff and Git index before each commit. Never add operational
coordinates or reviewer evidence, even if a file type is not blocked.
