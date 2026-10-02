# Part 8 catalogue discovery

`part8-discovery` is a protected Supabase Edge Function. Supabase Cron invokes
it every 15 minutes with `POST`; the function rejects other methods and requests
whose `x-discovery-secret` does not match the server-only `PART8_CRON_SECRET`.
The browser must never receive that secret or the Supabase service-role key.

## Configuration

Set `PART8_DISCOVERY_ENABLED=true` only after the Part 6 AOI enablement rules
are satisfied. The default is `false`. The other server settings have bounded
defaults: a 60-minute overlap, 100 items per page, 20 pages, 5,000 items, a
10-second provider timeout, and three retry attempts. Preprocessing and model
versions default to `1.0.0` and must remain explicit semantic versions.

Create these Vault entries before enabling the hosted schedule:

- `project_url`: the project HTTPS URL
- `publishable_key`: the project publishable key used by the platform gateway
- `part8_cron_secret`: the same high-entropy value as the Edge Function's
  `PART8_CRON_SECRET`

The migration installs the stable `part8-stac-discovery` schedule with
`cron.schedule`; it does not write `cron.job` directly. Pause it with
`select cron.unschedule('part8-stac-discovery');`. Reapplying the migration
replaces the named schedule rather than adding another one.

## Discovery behavior

Each poll captures one UTC start time and searches from 60 minutes before that
time through the start time. It selects only enabled AOIs valid at that instant.
If policy versions overlap, the newest valid version for each AOI ID is used.

The CDSE request targets `sentinel-1-grd` with `sar:instrument_mode = IW` and
`product:type = IW_GRDH_1S`. Pagination follows only `POST` next links to
`https://stac.dataspace.copernicus.eu/v1/search`, requires the original filters
to remain unchanged, rejects repeated tokens, and stops at the configured page
and item limits.

Each successful response is streamed through a 5 MiB decoded-body limit before
JSON parsing, and a page cannot exceed its requested feature count. Geometry
validation caps polygons, rings, total positions, and positions per ring before
self-intersection checks, preventing one provider item from causing unbounded
memory or quadratic CPU work.

HTTP 429, provider 5xx, network interruption, and timeout failures are retried
with bounded exponential backoff and jitter. A valid `Retry-After` value is
honored up to the maximum delay. Permanent 4xx, malformed responses, invalid
geometry, and unsafe pagination are not retried.

Scene identity is `(source_provider, collection, provider_item_id)`. The raw
metadata checksum covers normalized acquisition, platform, orbit, product,
polarization, footprint, publication, asset, and disposition fields. Transport
headers, provider links, and URL query strings are excluded. Rediscovery keeps
the original first-discovery time, advances the last-discovery time, and updates
metadata without changing identity.

Only `dual_band` scenes containing VV and VH create processing jobs. A valid VV
scene without VH is retained as `missing_vh`; a scene without VV is retained as
`invalid_polarization`. The job identity remains
`(scene_id, aoi_id, preprocessing_version, model_version)`. Positive-area
PostGIS intersections create work; boundary contact alone does not. Existing job
state and transition timestamps are never reset.

## Operations and diagnosis

For a safe manual invocation, send an empty `POST` body to the function with the
platform key and `x-discovery-secret` from a server-side environment. The
response contains only the poll ID and counts. It never returns AOI geometry,
provider bodies, asset URLs, or credentials.

Use `app_private.discovery_poll_runs` for page, item, rejection, missing-VH,
scene, job, duration, warning, and named failure counts. The named failures are:

- `RATE_LIMITED`: CDSE kept returning 429 after bounded retries.
- `PROVIDER_TIMEOUT` or `PROVIDER_UNAVAILABLE`: check CDSE availability and the
  configured timeout; the run is failed, not reported as an empty success.
- `INVALID_PROVIDER_RESPONSE`: inspect the sanitized fixture shape and current
  CDSE queryables. Raw response bodies are not stored.
- `UNSAFE_PAGINATION`: a next link changed the origin, path, method, filters, or
  repeated a token.
- `PERSISTENCE_FAILED`: inspect database logs, migration state, PostGIS, and
  service-role RPC grants. Do not broaden RLS or expose private tables.

This checkout has no linked Supabase project. Local migration and PostGIS replay
tests do not prove hosted Edge Function deployment or Cron execution.
