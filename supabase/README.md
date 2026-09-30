# Supabase boundary

Part 5 adds a local SQL migration for architecture-contract invariants. It uses
the unexposed `app_private` schema, enables row-level security as defense in
depth, and grants no client role access. No project, credential, remote
connection, function deployment, or seed data is configured.

The migration enforces repeated-discovery, immutable-job, stable-candidate, and
repeated-alert-approval keys. Application callers must use upsert/conflict
handling as documented in `docs/architecture/idempotency.md`; a uniqueness error
is not a substitute for returning the existing record.
