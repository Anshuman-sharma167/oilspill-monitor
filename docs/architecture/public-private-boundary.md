# Public-code and private-data boundary

The Git repository stores source code, documentation, and deliberately synthetic
fixtures. Operational data stays outside Git in access-controlled storage.

Private material includes operational coordinates, raw and derived satellite
products, candidate records, reviewer decisions and evidence, exports,
credentials, signed URLs, model weights, checkpoints, generated masks, and
review imagery. These materials must not be converted into a fixture or example
merely by renaming or trimming them.

Interfaces should pass identifiers and minimum necessary metadata. Logs and
errors must avoid private payloads. A future release process must verify
licences and provenance independently for every external dataset and model; the
code licence does not cover those assets.
