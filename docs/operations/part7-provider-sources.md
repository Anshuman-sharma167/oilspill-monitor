# Part 7 provider source note

Checked 2026-10-01 against CDSE and openEO primary documentation, then verified
with the project OAuth client on 2026-10-02. The sanitized live evidence is in
`data/fixtures/part7/openeo-live-pilot-evidence.sanitized.json`.

## Identity and tokens

- The core CDSE batch openEO endpoint is
  `https://openeo.dataspace.copernicus.eu`; the federated endpoint is
  `https://openeofed.dataspace.copernicus.eu`. Running workflows requires CDSE
  OpenID Connect authentication. The openEO Python client supports interactive
  login, stored refresh tokens, and
  `authenticate_oidc_client_credentials(client_id, client_secret)` for
  machine-to-machine use.
  [CDSE openEO getting started](https://documentation.dataspace.copernicus.eu/APIs/openEO/Python_Client/Python.html),
  [openEO authentication](https://documentation.dataspace.copernicus.eu/APIs/openEO/authentication.html),
  [client credentials](https://documentation.dataspace.copernicus.eu/APIs/openEO/authentication/client_credentials.html).
- CDSE describes service-account client credentials as experimental. A service
  account's openEO jobs, results, and credit balance are separate from a
  personal account's. CDSE support can link the balances; the web editor cannot
  display service-account jobs. For a project-owned service account, CDSE
  recommends requesting one through its help center; the Sentinel Hub dashboard
  can issue a personal OAuth client for initial testing.
  [CDSE client credentials](https://documentation.dataspace.copernicus.eu/APIs/openEO/authentication/client_credentials.html).
- The CDSE OIDC client-credentials token URL is
  `https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token`
  with form grant `client_credentials`, client ID, client secret, and the
  `openid email` scopes required for openEO. Sentinel Hub says to reuse access
  tokens until expiry (`exp`), because token requests are rate limited. Keep
  both tokens and secrets out of logs. This token recipe is explicitly
  documented for Sentinel Hub; confirm the chosen openEO client accepts the
  resulting token before treating hand-rolled token exchange as verified openEO
  integration.
  [Sentinel Hub authentication](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Overview/Authentication.html),
  [CDSE openEO client credentials](https://documentation.dataspace.copernicus.eu/APIs/openEO/authentication/client_credentials.html).
- Public
  `GET https://openeo.dataspace.copernicus.eu/openeo/1.0/credentials/oidc`
  returned provider ID `CDSE` and issuer
  `https://identity.dataspace.copernicus.eu/auth/realms/CDSE` on 2026-10-01. Its
  `/conformance` response did not advertise JWT authentication. The documented
  compatible openEO 1.x header is therefore
  `Authorization: Bearer oidc/CDSE/<access_token>`; let a supported client
  choose the form when possible.
  [openEO API authentication](https://api.openeo.org/),
  [CDSE OIDC provider metadata](https://openeo.dataspace.copernicus.eu/openeo/1.0/credentials/oidc),
  [CDSE conformance](https://openeo.dataspace.copernicus.eu/openeo/1.0/conformance).
- CDSE has a
  [two-factor authentication setup guide](https://documentation.dataspace.copernicus.eu/2FA.html)
  for the human account. The service-account secret remains a separate
  credential.
  [CDSE client credentials](https://documentation.dataspace.copernicus.eu/APIs/openEO/authentication/client_credentials.html).

## STAC discovery

- The CDSE STAC root is `https://stac.dataspace.copernicus.eu/v1/`; POST item
  searches to `/search`. Its Sentinel-1 GRD collection is `sentinel-1-grd`. The
  old `https://catalogue.dataspace.copernicus.eu/stac` endpoint was deprecated
  in November 2025. Check `/collections/sentinel-1-grd/queryables` before
  building filters.
  [CDSE STAC documentation](https://documentation.dataspace.copernicus.eu/APIs/STAC.html).
- CDSE's own migration example filters Sentinel-1 GRD on
  `product:type=IW_GRDH_1S` and on both `VV` and `VH` in `sar:polarizations`. It
  gives `query` and CQL2 `filter` examples. For a Part 7 fixture, add a narrow
  `datetime` and `bbox`/`intersects`, cap `limit`, then sanitize returned
  metadata before committing it.
  [CDSE STAC migration example](https://documentation.dataspace.copernicus.eu/notebook-samples/geo/migration_of_opensearch_to_stac_guide.html),
  [CDSE STAC search](https://documentation.dataspace.copernicus.eu/APIs/STAC.html).
- Do not substitute the separate Sentinel Hub Catalog endpoint
  (`https://sh.dataspace.copernicus.eu/catalog/v1/search`) without changing its
  authentication and pagination assumptions.
  [Sentinel Hub Catalog API](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Catalog.html),
  [CDSE STAC documentation](https://documentation.dataspace.copernicus.eu/APIs/STAC.html).

## openEO collection and job lifecycle

- In the core CDSE openEO backend, the collection ID is `SENTINEL1_GRD`, with
  `VV` and `VH` bands in the official example. Public
  `GET https://openeo.dataspace.copernicus.eu/openeo/1.0/collections/SENTINEL1_GRD`
  returned band values `HH`, `HV`, `VH`, `VV` on 2026-10-01. Presence in
  collection metadata does not prove both bands exist for a particular scene;
  inspect the chosen scene.
  [CDSE Sentinel-1 documentation](https://documentation.dataspace.copernicus.eu/Data/Sentinel1.html),
  [openEO collection metadata](https://openeo.dataspace.copernicus.eu/openeo/1.0/collections/SENTINEL1_GRD).
- The openEO batch API creates a job with `POST /jobs`, starts it with
  `POST /jobs/{job_id}/results`, reads status and metadata with
  `GET /jobs/{job_id}`, obtains result assets with `GET /jobs/{job_id}/results`,
  and cancels processing with `DELETE /jobs/{job_id}/results`. Status normally
  moves `created` to `queued`/`running` to `finished` or `error`; cancellation
  can yield `canceled` or return to `created`. Persist the provider job ID
  before any retry of start or polling.
  [openEO API specification](https://api.openeo.org/).
- The job metadata can report `costs` and `usage`; usage may appear only after
  completion or error. `GET /jobs/{job_id}/estimate` is defined but estimates
  may be incomplete or unavailable and are not a guaranteed charge cap. The
  result endpoint returns asset links; CDSE says each results request creates
  freshly signed asset URLs valid for seven days.
  [openEO API specification](https://api.openeo.org/),
  [CDSE job configuration](https://documentation.dataspace.copernicus.eu/APIs/openEO/job_config.html).

## Credits and dispatch checks

- CDSE currently documents **10,000 monthly free openEO credits** for a
  Copernicus General user, replenished on the first of the month. It also says
  costs vary with CPU, memory, storage, and data access; run a small job to
  establish an empirical estimate. Treat both the monthly allowance and unit
  prices as provider policy that can change.
  [CDSE credit usage](https://documentation.dataspace.copernicus.eu/APIs/openEO/credit_usage.html).
- The openEO API permits `GET /me` to return a remaining `budget`, but makes
  that field optional; it does not define separate allowance and used-credit
  fields. Public unauthenticated
  `GET https://openeo.dataspace.copernicus.eu/openeo/1.0/` returned
  `billing.currency=credits` on 2026-10-01; unauthenticated `GET /me`
  returned 401. The authenticated project response on 2026-10-02 contained
  `info`, `name`, and `user_id`; its `info` object contained only
  `oidc_userinfo`, with no allowance, usage, or budget value. Therefore the
  project cannot claim an API-based usage cache works. The documented CDSE
  account balance is also visible in the Algorithm Plaza Billing tab.
  [openEO API specification](https://api.openeo.org/),
  [CDSE credit usage](https://documentation.dataspace.copernicus.eu/APIs/openEO/credit_usage.html).
- A provider-side credit check can block starting batch work when credit balance
  falls below zero. This does not replace the project's Part 7 P2 fail-closed
  dispatch rule or its required persistent `deferred_quota` test.
  [CDSE federation API contract](https://documentation.dataspace.copernicus.eu/APIs/openEO/federation/backends/api.html).
- On transient HTTP 5xx, openEO says retrying the same request is reasonable.
  The standard also defines 401/403 authorization failure and quota/payment
  errors separately. Reconcile any ambiguous `POST /jobs` outcome against
  persisted job identity before resubmission, so a timeout cannot create two
  billable jobs. This reconciliation rule is a project safety inference, not a
  provider guarantee. [openEO API specification](https://api.openeo.org/).

## Project verification result

Token acquisition, authenticated account access, the sanitized pilot-area STAC
response, VV/VH collection and scene checks, and a versioned minimal batch job
were verified on 2026-10-02. The job finished, reported 4 billed credits, and
produced a 31,755-byte GeoTIFF. The repository test forces quota exhaustion and
checks that the processing job and dispatch decision persist as
`deferred_quota`. The repository scan found no credential material. A live
monthly usage source remains unavailable, so ordinary P2 dispatch remains
closed.
