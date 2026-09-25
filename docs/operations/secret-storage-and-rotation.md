# Secret storage and rotation

`.env.example` contains names and comments only. Local values belong in ignored
environment files and must never contain production data in tests. The only
browser-allowlisted names are `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Their use
still requires correctly configured Row Level Security. Service-role keys,
storage credentials, Telegram tokens, CDSE secrets, GitHub dispatch tokens, and
all other privileged credentials are server-only.

Server configuration must be loaded through `packages/config/src/server.ts` at
command startup. Missing values report variable names only. Code must not log,
serialize, snapshot, cache, bundle, or include secret values in errors. Do not
pass secrets through Docker build arguments or image environment metadata.

## Production stores

- GitHub workflows must use repository or environment-level GitHub Actions
  secrets with the smallest practical scope. Prefer environment approval and
  short-lived identity where available. Workflows must explicitly map a needed
  secret and must never print it.
- Supabase Edge Function secrets must be stored as Supabase project secrets.
  Supabase reserves the `SUPABASE_` prefix and provides its own URL and key
  variables. Store only later-part third-party server credentials through the
  project secret store; never put a service-role or secret key in browser code.
- Cloudflare Worker and R2 credentials must be stored as Cloudflare secrets or
  secret bindings, not plaintext Wrangler variables. Configure them through the
  Cloudflare dashboard or later approved, version-pinned deployment tooling.

No production secret is required or accepted by the Part 4 setup, check, sample,
container, or test commands.

## Accidental exposure response

1. Revoke or invalidate the exposed credential.
2. Generate a replacement with the minimum required privileges.
3. Update the correct GitHub, Supabase, or Cloudflare secret store.
4. Redeploy every affected service without putting the value in command history.
5. Validate the replacement using a non-logging, service-specific check.
6. Inspect the current tree and all reachable Git history with
   `npm run scan:repo`.
7. Remove exposed material safely from the current tree and history where
   required; coordinate history rewriting before force-updating shared refs.
8. Record the incident, scope, revocation time, and remediation without
   reproducing the credential.

Assume a committed or logged credential is compromised even if the repository
was private or the value was later deleted. Repository history removal does not
replace revocation.
