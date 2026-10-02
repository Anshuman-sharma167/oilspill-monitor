import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { MissingServerConfigError } from "../../packages/config/src/server.js";
import {
  processingJobId,
  sceneId,
} from "../../packages/schemas/src/identity.js";
import {
  CdseAuth,
  CdseProvider,
  decideDispatch,
  minimalJobDefinition,
  parseUsage,
  ProviderError,
  sanitizeStac,
  UsageCache,
  validateCollection,
  validateSanitizedStac,
  type PilotJob,
  type UsageSnapshot,
} from "../../services/worker/src/part7.js";
import { Part7Dispatch } from "../../services/worker/src/part7-dispatch.js";

const fixture = JSON.parse(
  readFileSync(
    "data/fixtures/part7/stac-sentinel1-grd-2025-01-31.sanitized.json",
    "utf8",
  ),
) as Record<string, unknown>;
const collection = JSON.parse(
  readFileSync(
    "data/fixtures/part7/openeo-sentinel1-grd.sanitized.json",
    "utf8",
  ),
) as Record<string, unknown>;
const liveEvidence = JSON.parse(
  readFileSync(
    "data/fixtures/part7/openeo-live-pilot-evidence.sanitized.json",
    "utf8",
  ),
) as Record<string, unknown>;
const now = "2026-10-01T12:00:00.000Z";
const usage: UsageSnapshot = {
  allowance: 100,
  used: 10,
  fetchedAt: now,
  accountingMonth: "2026-10",
  scope: "cdse-openeo-service-account",
  provenance: "provider-reported",
};

test("configuration errors name only missing variables", () => {
  assert.throws(
    () => CdseAuth.fromEnvironment({}),
    (error: unknown) =>
      error instanceof MissingServerConfigError &&
      error.message.includes("CDSE_CLIENT_SECRET"),
  );
});

test("token cache respects expiry and coalesces concurrent acquisition", async () => {
  let calls = 0;
  let instant = 0;
  const mock = (async (_url: string, init: RequestInit) => {
    calls += 1;
    assert.equal(init.method, "POST");
    const t = `test-${calls}`;
    return new Response(JSON.stringify({ access_token: t, expires_in: 60 }), {
      status: 200,
    });
  }) as typeof fetch;
  const auth = new CdseAuth("client", "private", mock, () => instant, 10_000);
  assert.deepEqual(await Promise.all([auth.token(), auth.token()]), [
    "test-1",
    "test-1",
  ]);
  assert.equal(calls, 1);
  instant = 49_000;
  assert.equal(await auth.token(), "test-1");
  instant = 50_000;
  assert.equal(await auth.token(), "test-2");
  instant = 111_000;
  assert.equal(await auth.token(), "test-3");
});

test("token acquisition requests the openEO OIDC scopes", async () => {
  let requestBody = "";
  const auth = new CdseAuth(
    "client-id",
    "client-secret",
    async (_url, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ access_token: "test-token", expires_in: 60 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  await auth.token();

  const params = new URLSearchParams(requestBody);
  assert.equal(params.get("grant_type"), "client_credentials");
  assert.equal(params.get("scope"), "openid email");
  assert.equal(params.get("client_id"), "client-id");
  assert.equal(params.get("client_secret"), "client-secret");
});

test("auth errors and malformed responses never include credential material", async () => {
  for (const [status, expected] of [
    [401, "AUTH_REJECTED"],
    [423, "AUTH_LOCKED"],
    [429, "RATE_LIMITED"],
    [503, "PROVIDER_UNAVAILABLE"],
  ] as const) {
    const mock = (async () =>
      new Response("secret-payload", {
        status,
        headers: status === 429 ? { "retry-after": "2" } : {},
      })) as typeof fetch;
    const auth = new CdseAuth("private-id", "private-secret", mock);
    await assert.rejects(
      auth.token(),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === expected &&
        !JSON.stringify(error).includes("private") &&
        !error.message.includes("secret-payload") &&
        (status !== 429 || error.retryAfterMs === 2000),
    );
  }
  const malformed = new CdseAuth(
    "id",
    "secret",
    (async () =>
      new Response(
        JSON.stringify({ access_token: ["raw", "-token"].join("") }),
        {
          status: 200,
        },
      )) as typeof fetch,
  );
  await assert.rejects(malformed.token(), {
    message: "INVALID_PROVIDER_RESPONSE",
  });
});

test("sanitized STAC fixture retains only stable public scene fields", () => {
  assert.doesNotThrow(() => validateSanitizedStac(fixture));
  const raw = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: (fixture.features as Array<{ id: string }>)[0]?.id,
        collection: "sentinel-1-grd",
        properties: {
          datetime: "2025-01-31T01:03:48Z",
          "sar:polarizations": ["VV", "VH"],
          token: "private",
        },
        assets: { href: "https://private.invalid/?token=raw" },
        links: [],
      },
    ],
    request_id: "private-id",
  };
  assert.deepEqual(sanitizeStac(raw), fixture);
  assert.ok(
    !JSON.stringify(fixture).match(
      /token|secret|href|cookie|request_id|account_id/iu,
    ),
  );
  assert.throws(
    () => sanitizeStac({ type: "Collection", features: [] }),
    ProviderError,
  );
  const unsafeId = structuredClone(raw);
  unsafeId.features[0]!.id = "scene?token=private";
  assert.throws(() => sanitizeStac(unsafeId), ProviderError);
  assert.throws(
    () => validateSanitizedStac({ ...fixture, token: "x" }),
    ProviderError,
  );
});

test("Sentinel-1 GRD requires VV and VH in collection and selected scene", () => {
  assert.doesNotThrow(() => validateCollection(collection));
  const dimensions = collection["cube:dimensions"] as {
    bands: { values: string[] };
  };
  for (const band of ["VV", "VH"]) {
    const changed = structuredClone(collection);
    (changed["cube:dimensions"] as typeof dimensions).bands.values =
      dimensions.bands.values.filter((value) => value !== band);
    assert.throws(() => validateCollection(changed), ProviderError);
  }
  assert.throws(() => validateCollection({}), ProviderError);
  assert.throws(
    () => validateCollection({ ...collection, id: "OTHER" }),
    ProviderError,
  );
  const badScene = structuredClone(fixture);
  (badScene.features as Array<{ polarizations: string[] }>)[0]!.polarizations =
    ["VV"];
  assert.throws(() => validateSanitizedStac(badScene), ProviderError);
});

test("result size uses a trusted metadata-only asset request when omitted", async () => {
  const auth = new CdseAuth("client-id", "client-secret", async () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ access_token: "test-token", expires_in: 60 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    ),
  );
  const provider = new CdseProvider(auth, async (url, init) => {
    if (String(url).startsWith("https://openeo.dataspace.copernicus.eu/"))
      return new Response(
        JSON.stringify({
          assets: {
            output: {
              href: "https://results.dataspace.copernicus.eu/output.tif?signature=private",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    assert.equal(init?.method, "HEAD");
    return new Response(null, {
      status: 200,
      headers: { "content-length": "31755" },
    });
  });

  assert.equal(await provider.resultSize("j-test-one"), 31755);
});

test("sanitized live evidence records the completed versioned pilot", () => {
  assert.equal(liveEvidence.evidence_version, "1.0.0");
  assert.equal(liveEvidence.graph_version, "1.0.0");
  assert.equal(liveEvidence.provider_status, "finished");
  assert.equal(liveEvidence.actual_cost_provenance, "provider-reported");
  assert.equal(liveEvidence.output_size_provenance, "provider-reported");
  assert.equal(liveEvidence.billed_credits, 4);
  assert.equal(liveEvidence.output_bytes, 31755);
  for (const field of [
    "submitted_at",
    "start_requested_at",
    "provider_updated_at",
    "completed_at",
  ]) {
    const value = liveEvidence[field];
    assert.equal(typeof value, "string");
    assert.ok(Number.isFinite(Date.parse(String(value))));
  }
  assert.doesNotMatch(
    JSON.stringify(liveEvidence),
    /authorization|client_secret|access_token|signed|cookie|href/iu,
  );
});

test("usage cache requires provider allowance and used values", async () => {
  assert.deepEqual(
    parseUsage({ monthly_allowance: 100, monthly_used: 20 }, now).used,
    20,
  );
  for (const value of [NaN, -1, Infinity, "10"]) {
    assert.throws(
      () => parseUsage({ monthly_allowance: 100, monthly_used: value }, now),
      ProviderError,
    );
  }
  assert.throws(() => parseUsage({ budget: 80 }, now), ProviderError);
  let calls = 0;
  let instant = Date.parse(now);
  const cache = new UsageCache(
    {
      account: async () => {
        calls += 1;
        return { monthly_allowance: 100, monthly_used: 20 };
      },
    },
    () => instant,
    2000,
  );
  await Promise.all([cache.current(), cache.current()]);
  instant += 1000;
  await cache.current();
  assert.equal(calls, 1);
  instant += 2000;
  await cache.current();
  assert.equal(calls, 2);
});

test("quota decision fails closed, preserves 60/20/20, and uses provider allowance", () => {
  const base = {
    priority: "P2" as const,
    bucket: "scheduled" as const,
    estimate: 1,
    reservedTotal: 0,
    reservedBucket: 0,
    usage,
    reviewerRelease: false,
    now,
  };
  assert.equal(decideDispatch(base).state, "queue");
  assert.deepEqual(decideDispatch({ ...base, usage: null }), {
    state: "deferred_quota",
    reason: "USAGE_UNAVAILABLE",
  });
  assert.deepEqual(decideDispatch({ ...base, reservedTotal: 69 }), {
    state: "deferred_quota",
    reason: "P2_THRESHOLD",
  });
  assert.deepEqual(
    decideDispatch({ ...base, usage: { ...usage, used: 100 } }),
    { state: "deferred_quota", reason: "FREE_CREDITS_EXHAUSTED" },
  );
  assert.deepEqual(decideDispatch({ ...base, reservedBucket: 60 }), {
    state: "deferred_quota",
    reason: "BUCKET_EXHAUSTED",
  });
  assert.equal(
    decideDispatch({
      ...base,
      usage: { ...usage, fetchedAt: "2026-10-01T11:00:00.000Z" },
    }).state,
    "deferred_quota",
  );
  assert.equal(
    decideDispatch({ ...base, priority: "P1", usage: null }).reason,
    "REVIEW_REQUIRED",
  );
  assert.equal(
    decideDispatch({
      ...base,
      priority: "P1",
      usage: null,
      reviewerRelease: true,
    }).state,
    "queue",
  );
  assert.equal(
    decideDispatch({
      ...base,
      priority: "P0",
      bucket: "priority",
      usage: null,
      reviewerRelease: true,
    }).state,
    "queue",
  );
  assert.throws(() => decideDispatch({ ...base, estimate: -1 }), ProviderError);
});

const job: PilotJob = {
  localJobId: processingJobId(
    "scene:synthetic",
    "aoi:western-coast-shadow-pilot",
    "1.0.0",
    "1.0.0",
  ),
  sceneId: "scene:synthetic",
  aoiId: "aoi:western-coast-shadow-pilot",
  policyVersion: "1.0.0",
  priority: "P2",
  bbox: { west: 71.5, south: 18.1, east: 71.505, north: 18.105 },
  from: "2025-01-31T00:00:00Z",
  to: "2025-02-01T00:00:00Z",
};

test("minimal graph has immutable identity, tiny extent, two bands, and version", () => {
  const graph = minimalJobDefinition(job);
  assert.match(JSON.stringify(graph), /SENTINEL1_GRD/u);
  assert.match(JSON.stringify(graph), /"bands":\["VV","VH"\]/u);
  assert.throws(
    () => minimalJobDefinition({ ...job, localJobId: "job:wrong" }),
    ProviderError,
  );
  assert.throws(
    () =>
      minimalJobDefinition({
        ...job,
        bbox: { west: 69, south: 18, east: 73, north: 21 },
      }),
    ProviderError,
  );
});

test("Part 7 migration is private, append-only, and constrains accounting", () => {
  const sql = readFileSync(
    "supabase/migrations/20261001100000_part7_cdse_accounting.sql",
    "utf8",
  );
  for (const table of [
    "provider_usage_snapshots",
    "reviewer_releases",
    "provider_job_runs",
    "dispatch_decisions",
    "credit_ledger",
  ])
    assert.match(sql, new RegExp(`create table app_private\\.${table}`, "u"));
  assert.match(sql, /credit_ledger_append_only/u);
  assert.match(sql, /enable row level security/gu);
  assert.doesNotMatch(sql, /grant .* to (anon|authenticated)/iu);
});

test("database reservation is atomic, deferral persists, and retry does not duplicate", async () => {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
  await db.exec(
    readFileSync(
      "supabase/migrations/20260925090921_part5_architecture_contracts.sql",
      "utf8",
    ),
  );
  await db.exec(`
    create type app_private.aoi_priority as enum ('P0','P1','P2');
    create type app_private.coverage_gap_status as enum ('disabled','deferred','failed','unobserved');
    create table app_private.aois (aoi_id text, policy_version text, enabled boolean,
      priority app_private.aoi_priority, primary key (aoi_id, policy_version));
    create table app_private.monthly_credit_policies (policy_version text primary key);
    create table app_private.coverage_gaps (coverage_gap_id bigint generated always as identity primary key,
      aoi_id text, policy_version text, status app_private.coverage_gap_status,
      starts_at timestamptz, ends_at timestamptz, detail text);
  `);
  await db.exec(
    readFileSync(
      "supabase/migrations/20261001100000_part7_cdse_accounting.sql",
      "utf8",
    ),
  );
  await db.query("insert into app_private.aois values ($1, $2, true, 'P2')", [
    job.aoiId,
    job.policyVersion,
  ]);
  await db.query(
    "insert into app_private.monthly_credit_policies values ($1)",
    [job.policyVersion],
  );
  await db.query(
    "insert into app_private.scenes values ($1, 'synthetic', 'synthetic', $2, $2)",
    [job.sceneId, now],
  );
  await db.query(
    `insert into app_private.processing_jobs
    (job_id, scene_id, aoi_id, preprocessing_version, model_version, state, discovered_at, queued_at)
    values ($1, $2, $3, '1.0.0', '1.0.0', 'queued', $4, $4)`,
    [job.localJobId, job.sceneId, job.aoiId, now],
  );
  await assert.rejects(
    db.query(
      `insert into app_private.reviewer_releases
       (job_id, reviewer_id, reason, policy_version, released_at, condition_code)
       values ($1, 'application-user', 'release', $2, $3, 'USAGE_UNAVAILABLE')`,
      [job.localJobId, job.policyVersion, now],
    ),
    /reviewer release requires a separate reviewer login/u,
  );
  const dispatch = new Part7Dispatch(
    db,
    {
      current: async () => {
        throw new Error("offline");
      },
    },
    {
      createJob: async () => {
        throw new Error("must not submit");
      },
      startJob: async () => {
        throw new Error("must not start");
      },
      jobStatus: async () => {
        throw new Error("must not poll");
      },
      resultSize: async () => null,
      verifyCollection: async () => collection,
      verifyStac: async () => fixture as ReturnType<typeof sanitizeStac>,
    },
    () => new Date(now),
  );
  assert.equal(await dispatch.reserve(job, 2, "scheduled"), "deferred_quota");
  assert.equal(await dispatch.reserve(job, 2, "scheduled"), "deferred_quota");
  const states = await db.query<{ state: string }>(
    "select state from app_private.processing_jobs",
  );
  assert.deepEqual(
    states.rows.map((row) => row.state),
    ["deferred_quota"],
  );
  const gaps = await db.query("select * from app_private.coverage_gaps");
  assert.equal(gaps.rows.length, 1);
  const ledger = await db.query("select * from app_private.credit_ledger");
  assert.equal(ledger.rows.length, 0);

  const second = {
    ...job,
    sceneId: sceneId(
      "cdse-stac",
      (fixture.features as Array<{ id: string }>)[0]!.id,
    ),
    localJobId: processingJobId(
      sceneId("cdse-stac", (fixture.features as Array<{ id: string }>)[0]!.id),
      job.aoiId,
      "1.0.0",
      "1.0.0",
    ),
  };
  await db.query(
    "insert into app_private.scenes values ($1, 'synthetic', 'second', $2, $2)",
    [second.sceneId, now],
  );
  await db.query(
    `insert into app_private.processing_jobs
    (job_id, scene_id, aoi_id, preprocessing_version, model_version, state, discovered_at, queued_at)
    values ($1, $2, $3, '1.0.0', '1.0.0', 'queued', $4, $4)`,
    [second.localJobId, second.sceneId, second.aoiId, now],
  );
  let submissions = 0;
  const eligible = new Part7Dispatch(
    db,
    { current: async () => usage },
    {
      createJob: async () => {
        submissions += 1;
        return "j-test-one";
      },
      startJob: async () => undefined,
      jobStatus: async () => ({
        status: "finished",
        costs: 3,
        started: "2026-10-01T12:01:00Z",
      }),
      resultSize: async () => 123,
      verifyCollection: async () => collection,
      verifyStac: async () => fixture as ReturnType<typeof sanitizeStac>,
    },
    () => new Date(now),
    true,
  );
  assert.equal(await eligible.reconsider(job, 2, "scheduled"), "reserved");
  const history = await db.query<{ decision: string; reason_code: string }>(
    "select decision, reason_code from app_private.dispatch_decisions where job_id = $1 order by decision_id",
    [job.localJobId],
  );
  assert.deepEqual(history.rows, [
    { decision: "deferred_quota", reason_code: "USAGE_UNAVAILABLE" },
    { decision: "reserved", reason_code: "WITHIN_FREE_QUOTA" },
  ]);
  const closed = await db.query<{ ends_at: Date | null }>(
    "select ends_at from app_private.coverage_gaps where job_id = $1",
    [job.localJobId],
  );
  assert.ok(closed.rows[0]?.ends_at);
  assert.equal(await eligible.reserve(second, 2, "scheduled"), "reserved");
  assert.equal(await eligible.reserve(second, 2, "scheduled"), "reserved");
  assert.equal(await eligible.submit(second), "j-test-one");
  await assert.rejects(
    eligible.submit(second),
    /PART7_SUBMISSION_ALREADY_ATTEMPTED/u,
  );
  assert.equal(submissions, 1);
  await eligible.start(second.localJobId, "j-test-one");
  await eligible.observe(second.localJobId, "j-test-one");
  await eligible.observe(second.localJobId, "j-test-one");
  const run = await db.query<{
    state: string;
    actual_credits: string;
    output_bytes: number;
  }>(
    "select state, actual_credits::text, output_bytes from app_private.provider_job_runs where job_id = $1",
    [second.localJobId],
  );
  assert.deepEqual(run.rows[0], {
    state: "finished",
    actual_credits: "3",
    output_bytes: 123,
  });
  const entries = await db.query<{ entry_kind: string; credits: string }>(
    "select entry_kind, credits::text from app_private.credit_ledger where job_id = $1 order by entry_kind",
    [second.localJobId],
  );
  assert.deepEqual(entries.rows, [
    { entry_kind: "actual", credits: "3" },
    { entry_kind: "adjustment", credits: "1" },
    { entry_kind: "estimate", credits: "2" },
    { entry_kind: "release", credits: "2" },
  ]);
  await assert.rejects(
    db.query("delete from app_private.credit_ledger where job_id = $1", [
      second.localJobId,
    ]),
    /append-only/u,
  );

  const queueForAoi = async (aoiId: string, scene: string) => {
    const queued: PilotJob = {
      ...second,
      aoiId,
      sceneId: scene,
      localJobId: processingJobId(scene, aoiId, "1.0.0", "1.0.0"),
    };
    await db.query("insert into app_private.aois values ($1, $2, true, 'P2')", [
      aoiId,
      queued.policyVersion,
    ]);
    await db.query(
      `insert into app_private.processing_jobs
       (job_id, scene_id, aoi_id, preprocessing_version, model_version, state,
        discovered_at, queued_at)
       values ($1, $2, $3, '1.0.0', '1.0.0', 'queued', $4, $4)`,
      [queued.localJobId, scene, aoiId, now],
    );
    return queued;
  };
  const exhaustedJob = await queueForAoi("aoi:quota-exhausted", job.sceneId);
  const exhausted = new Part7Dispatch(
    db,
    { current: async () => ({ ...usage, used: 79 }) },
    {
      createJob: async () => {
        throw new Error("must not submit");
      },
      startJob: async () => undefined,
      jobStatus: async () => ({ status: "created" }),
      resultSize: async () => null,
      verifyCollection: async () => collection,
      verifyStac: async () => fixture as ReturnType<typeof sanitizeStac>,
    },
    () => new Date(now),
  );
  assert.equal(
    await exhausted.reserve(exhaustedJob, 2, "scheduled"),
    "deferred_quota",
  );
  const exhaustedDecision = await db.query<{ reason_code: string }>(
    "select reason_code from app_private.dispatch_decisions where job_id = $1",
    [exhaustedJob.localJobId],
  );
  assert.equal(exhaustedDecision.rows[0]?.reason_code, "P2_THRESHOLD");
  const exhaustedState = await db.query<{ state: string }>(
    "select state from app_private.processing_jobs where job_id = $1",
    [exhaustedJob.localJobId],
  );
  assert.equal(exhaustedState.rows[0]?.state, "deferred_quota");

  const failedJob = await queueForAoi("aoi:provider-failure", second.sceneId);
  assert.equal(
    await dispatch.reserve(failedJob, 2, "scheduled"),
    "deferred_quota",
  );
  const failureDispatch = new Part7Dispatch(
    db,
    { current: async () => usage },
    {
      createJob: async () => "j-test-failed",
      startJob: async () => undefined,
      jobStatus: async () => ({ status: "error", costs: 0 }),
      resultSize: async () => null,
      verifyCollection: async () => collection,
      verifyStac: async () => fixture as ReturnType<typeof sanitizeStac>,
    },
    () => new Date(now),
    true,
  );
  assert.equal(
    await failureDispatch.reconsider(failedJob, 2, "scheduled"),
    "reserved",
  );
  await failureDispatch.submit(failedJob);
  await failureDispatch.start(failedJob.localJobId, "j-test-failed");
  await failureDispatch.observe(failedJob.localJobId, "j-test-failed");
  const failedGap = await db.query<{
    status: string;
    ends_at: Date | null;
  }>(
    "select status, ends_at from app_private.coverage_gaps where job_id = $1",
    [failedJob.localJobId],
  );
  assert.equal(failedGap.rows[0]?.status, "failed");
  assert.equal(failedGap.rows[0]?.ends_at, null);
  await db.close();
});
