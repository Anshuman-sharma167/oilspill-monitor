# Part 9 primary-source note

Checked 2026-10-03 against current PostgreSQL 18, Supabase, and GitHub
documentation. This note supports the Part 9 queue and dispatch design; it does
not describe a hosted deployment or completed live authorization test.

## PostgreSQL claiming and locking

- `SELECT ... FOR UPDATE` locks selected rows against concurrent lockers and
  writers until the transaction ends. `SKIP LOCKED` skips a row that another
  transaction cannot lock immediately. PostgreSQL explicitly identifies
  queue-like tables with multiple consumers as an appropriate use, while warning
  that the result is an inconsistent view and is unsuitable for general-purpose
  reads.
  [PostgreSQL `SELECT` locking clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE),
  [row-level locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).
- The claim operation should therefore select one eligible row, update its
  state, claimant, fencing token, attempt count, and lease, and return it in one
  database transaction. The documented semantics also mean priority ordering is
  among currently lockable rows: a locked P0 row can be skipped while another
  consumer claims the next eligible row. A deterministic `ORDER BY` and
  `LIMIT 1` do not turn `SKIP LOCKED` into global serialization.
  [PostgreSQL `SELECT` locking clause](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE).
- Row locks do not block ordinary readers; they block writers and lockers of the
  same row. They are released when the transaction ends. Lease expiry and claim
  tokens are therefore durable application fencing, not substitutes for the
  short transaction that performs the claim.
  [PostgreSQL row-level locks](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).

## PostgreSQL and Supabase function security

- PostgreSQL functions are `SECURITY INVOKER` by default and use the caller's
  privileges. `SECURITY DEFINER` uses the owner's privileges and needs special
  care: object resolution must not include schemas where untrusted users can
  create objects. Supabase's current guidance is stricter for definer functions:
  set `search_path = ''` and schema-qualify every referenced object. Prefer
  invoker functions unless owner privileges are required.
  [PostgreSQL `CREATE FUNCTION`](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY),
  [PostgreSQL function security](https://www.postgresql.org/docs/current/perm-functions.html),
  [Supabase database functions](https://supabase.com/docs/guides/database/functions#security-definer-vs-invoker).
- PostgreSQL grants `EXECUTE` on new functions to `PUBLIC` by default.
  PostgreSQL recommends revoking that default and selectively granting execute
  access in the same transaction as function creation, which avoids a public
  exposure window. Supabase separately recommends revoking `PUBLIC`, `anon`, and
  `authenticated`, setting safe default privileges for future functions, and
  granting only the server role that needs each function.
  [PostgreSQL `CREATE FUNCTION`](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY),
  [PostgreSQL privileges](https://www.postgresql.org/docs/current/ddl-priv.html),
  [Supabase function privileges](https://supabase.com/docs/guides/database/functions#function-privileges).
- Keep `app_private` out of the Data API's exposed schemas and do not grant
  browser roles schema usage or object access. This blocks the Data API surface,
  but it does not replace direct PostgreSQL privileges. RLS and grants are
  separate controls, and RLS does not apply to function execution; private queue
  functions still need explicit `EXECUTE` restrictions. A schema-qualified
  private helper can be used without adding its schema to PostgREST's exposed
  schemas or extra search path.
  [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api),
  [custom schemas](https://supabase.com/docs/guides/api/using-custom-schemas),
  [private security-definer helpers](https://supabase.com/docs/guides/troubleshooting/do-i-need-to-expose-security-definer-functions-in-row-level-security-policies-iI0uOw).
- Supabase announced a change that removes automatic Data API and GraphQL grants
  for new `public` tables, with enforcement for existing projects scheduled for
  2026-10-30. The change does not make older grants, custom schemas, functions,
  or direct database roles safe by default. Part 9 should continue to declare
  and test its grants explicitly instead of relying on the project's creation
  date or platform defaults.
  [Supabase changelog: automatic exposure change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).

## GitHub Actions dispatch and authorization

- A `workflow_dispatch` workflow declares its accepted inputs in the workflow
  file and receives the event only when that file exists on the default branch.
  For Part 9, declare exactly one required string input, `job_id`. The REST
  dispatch request also requires a `ref`; keep that as trusted dispatcher
  configuration rather than another caller-supplied workflow input.
  [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatchinputs),
  [workflow dispatch REST endpoint](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
- The dispatch endpoint accepts GitHub App installation access tokens and
  requires repository `Actions: write`. An installation token can be narrowed to
  selected repositories and permissions already granted to the App and expires
  after one hour. This is the documented short-lived credential for an external
  Part 9 dispatcher; do not replace it with a personal access token or assume a
  fixed token length.
  [workflow dispatch REST endpoint](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event),
  [GitHub App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
- GitHub OIDC solves a different boundary. A running job needs `id-token: write`
  to request an OIDC JWT and can exchange it with a configured external trust
  provider for short-lived access. That permission does not grant write access
  to resources. If the job checks out this repository, add `contents: read`;
  permissions not declared after an explicit `permissions` block are set to
  `none`. OIDC inside a run cannot authenticate the earlier API call that
  created that run.
  [GitHub OIDC reference](https://docs.github.com/en/actions/reference/security/oidc#workflow-permissions-for-the-requesting-the-oidc-token),
  [workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).
- Pin every third-party action to a full-length commit SHA. GitHub describes a
  full SHA as the only immutable action reference and says to verify that it
  belongs to the action's real repository rather than a fork. The version tag
  shown in some GitHub App examples is not sufficient for this repository's
  production workflow.
  [GitHub secure-use reference](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions),
  [GitHub App workflow example](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow).
- A concurrency group can serialize runs that share a key, so a group derived
  from the validated `job_id` is useful as a second guard. GitHub does not
  guarantee dispatch-order execution, group names are case-insensitive, and
  pending or active runs may be replaced or cancelled depending on the
  concurrency settings. PostgreSQL claim and lease fencing must remain the
  authority; Actions concurrency is only supplemental protection.
  [GitHub concurrency control](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Part 9 design consequences

1. Make claim, transition, attempt increment, and lease creation one PostgreSQL
   transaction using `FOR UPDATE SKIP LOCKED`.
2. Fence every later mutation with the persisted claim token or lease
   generation; transaction locks alone do not protect work after commit.
3. Keep queue functions in `app_private`, prefer invoker security, use an empty
   `search_path` and fully qualified objects for any necessary definer function,
   and test that browser roles cannot execute them.
4. Give the external dispatcher a repository-scoped, one-hour GitHub App
   installation token with only `Actions: write`. Give the runner OIDC only if
   its external trust exchange is configured and verified.
5. Accept only `job_id` as workflow input, pin the workflow ref in trusted
   configuration, fetch authoritative job data after startup, and treat
   job-keyed Actions concurrency as defense in depth rather than queue state.
