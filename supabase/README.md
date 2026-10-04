# Supabase boundary

Part 5 adds a local SQL migration for architecture-contract invariants. It uses
the unexposed `app_private` schema, enables row-level security as defense in
depth, and grants no client role access. No project, credential, remote
connection, function deployment, or seed data is configured.

The migration enforces repeated-discovery, immutable-job, stable-candidate, and
repeated-alert-approval keys. Application callers must use upsert/conflict
handling as documented in `docs/architecture/idempotency.md`; a uniqueness error
is not a substitute for returning the existing record.

Part 8 also includes the protected `part8-discovery` Edge Function. Its Cron
target reads `project_url`, `publishable_key`, and `part8_cron_secret` from
Vault; see `docs/operations/part8-discovery.md` before deployment.

Part 9 adds the private PostgreSQL processing queue, fenced worker leases,
immutable stage checkpoints, bounded retry and recovery functions, and audited
human requeue. Browser roles have no schema or function access. Apply
`20261003163000_part9_postgres_queue.sql` only after Parts 5–8 and verify it
with `npm run test:part9`; use `npm run test:part9:postgres` only against an
empty disposable PostgreSQL/PostGIS database.
