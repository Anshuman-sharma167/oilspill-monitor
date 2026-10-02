import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { postgis } from "@electric-sql/pglite-postgis";

import { sceneId } from "../../packages/schemas/src/identity.js";
import { SqlDiscoveryDatabase } from "../../services/discovery/src/database.js";
import {
  authenticateCron,
  catalogueSceneId,
  DiscoveryService,
  normalizeStacItem,
  PART8_MAX_RESPONSE_BYTES,
  PART8_MAX_RING_POSITIONS,
  Part8Error,
  pollWindow,
  readPart8Config,
  stacSearchBody,
  validGeometry,
  type CompletePollInput,
  type DiscoveryDatabase,
  type Part8Config,
  type PersistenceResult,
} from "../../services/discovery/src/index.js";

const fixture = JSON.parse(
  readFileSync("data/fixtures/part8/stac-items.json", "utf8"),
) as { features: Array<Record<string, unknown>> };
const validItem = fixture.features[0]!;
const missingVhItem = fixture.features[1]!;
const malformedItem = fixture.features[2]!;
const instant = "2026-10-03T01:00:00.000Z";
const geometry = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ],
  ],
};

const config = (overrides: Partial<Part8Config> = {}): Part8Config => ({
  enabled: true,
  overlapMinutes: 60,
  pageSize: 100,
  maxPages: 20,
  maxItems: 5_000,
  requestTimeoutMs: 1_000,
  retryAttempts: 3,
  initialRetryDelayMs: 100,
  maxRetryDelayMs: 1_000,
  preprocessingVersion: "1.0.0",
  modelVersion: "1.0.0",
  ...overrides,
});

class MemoryDatabase implements DiscoveryDatabase {
  aois = [{ aoiId: "aoi:one", policyVersion: "1.0.0", geometry }];
  completed: CompletePollInput[] = [];
  failed: string[] = [];

  async enabledAois() {
    return this.aois;
  }

  async complete(input: CompletePollInput): Promise<PersistenceResult> {
    this.completed.push(input);
    return {
      pollRunId: this.completed.length,
      createdSceneCount: input.scenes.length,
      updatedSceneCount: 0,
      createdJobCount: input.scenes.filter(
        (scene) => scene.polarizationDisposition === "dual_band",
      ).length,
      existingJobCount: 0,
    };
  }

  async fail(input: { code: string }) {
    this.failed.push(input.code);
    return this.failed.length;
  }
}

const page = (
  features: unknown[],
  links: unknown[] = [],
  status = 200,
  headers: HeadersInit = {},
) =>
  new Response(JSON.stringify({ type: "FeatureCollection", features, links }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const service = (
  database: DiscoveryDatabase,
  fetcher: typeof fetch,
  overrides: Partial<Part8Config> = {},
  sleep: (milliseconds: number) => Promise<void> = async () => undefined,
) =>
  new DiscoveryService({
    database,
    fetcher,
    config: config(overrides),
    now: () => new Date(instant),
    random: () => 0,
    sleep,
  });

test("configuration and overlapping UTC windows fail closed", () => {
  const defaults = readPart8Config({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.overlapMinutes, 60);
  assert.throws(
    () => readPart8Config({ PART8_POLL_OVERLAP_MINUTES: "44" }),
    (error: unknown) =>
      error instanceof Part8Error && error.code === "INVALID_CONFIG",
  );
  const first = pollWindow(new Date(instant), 60);
  const second = pollWindow(new Date("2026-10-03T01:15:00.000Z"), 60);
  assert.equal(first.from, "2026-10-03T00:00:00.000Z");
  assert.ok(Date.parse(second.from) < Date.parse(first.to));
});

test("STAC requests contain the verified Sentinel-1 IW GRD filters", () => {
  const body = stacSearchBody(geometry, pollWindow(new Date(instant), 60), 50);
  assert.deepEqual(body.collections, ["sentinel-1-grd"]);
  assert.equal(body["filter-lang"], "cql2-json");
  assert.match(JSON.stringify(body.filter), /sar:instrument_mode.*IW/u);
  assert.match(JSON.stringify(body.filter), /product:type.*IW_GRDH_1S/u);
  assert.equal(body.limit, 50);
});

test("normalization rejects malformed geometry and sanitizes assets", async () => {
  const normalized = await normalizeStacItem(validItem, instant);
  assert.deepEqual(normalized.polarizations, ["VH", "VV"]);
  assert.equal(normalized.polarizationDisposition, "dual_band");
  assert.equal(normalized.assets[0]?.href.includes("?"), false);
  await assert.rejects(
    normalizeStacItem(malformedItem, instant),
    (error: unknown) =>
      error instanceof Part8Error && error.code === "INVALID_PROVIDER_RESPONSE",
  );
  const missing = await normalizeStacItem(missingVhItem, instant);
  assert.equal(missing.polarizationDisposition, "missing_vh");
  const database = new MemoryDatabase();
  const poll = await service(database, async () =>
    page([malformedItem]),
  ).poll();
  assert.equal(poll.rejectedItemCount, 1);
  assert.equal(database.completed[0]?.scenes.length, 0);
});

test("provider bodies and geometry complexity are bounded before expensive work", async () => {
  const oversizedRing = Array.from(
    { length: PART8_MAX_RING_POSITIONS + 1 },
    (_, index) => [index % 2, index % 3],
  );
  oversizedRing.push(oversizedRing[0]!);
  assert.equal(
    validGeometry({ type: "Polygon", coordinates: [oversizedRing] }),
    false,
  );

  const declared = new Response("{}", {
    headers: { "content-length": String(PART8_MAX_RESPONSE_BYTES + 1) },
  });
  await assert.rejects(
    service(new MemoryDatabase(), async () => declared).poll(),
    (error: unknown) =>
      error instanceof Part8Error && error.code === "LIMIT_EXCEEDED",
  );

  const chunk = new Uint8Array(1024 * 1024);
  let emitted = 0;
  const streamed = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
        emitted += chunk.byteLength;
        if (emitted > PART8_MAX_RESPONSE_BYTES) controller.close();
      },
    }),
  );
  await assert.rejects(
    service(new MemoryDatabase(), async () => streamed).poll(),
    (error: unknown) =>
      error instanceof Part8Error && error.code === "LIMIT_EXCEEDED",
  );

  await assert.rejects(
    service(
      new MemoryDatabase(),
      async () => new Response(JSON.stringify({ type: "invalid" })),
    ).poll(),
    (error: unknown) =>
      error instanceof Part8Error && error.code === "INVALID_PROVIDER_RESPONSE",
  );
});

test("collection participates in deterministic scene identity", async () => {
  const first = await catalogueSceneId(
    "cdse-stac",
    "collection-one",
    "same-id",
  );
  const second = await catalogueSceneId(
    "cdse-stac",
    "collection-two",
    "same-id",
  );
  assert.notEqual(first, second);
  assert.equal(first, sceneId("cdse-stac", "same-id", "collection-one"));
});

test("empty and duplicate pages finish without duplicate normalized scenes", async () => {
  const emptyDatabase = new MemoryDatabase();
  const empty = await service(emptyDatabase, async () => page([])).poll();
  assert.equal(empty.normalizedItemCount, 0);
  assert.equal(empty.createdJobCount, 0);

  const database = new MemoryDatabase();
  let calls = 0;
  const result = await service(database, async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (calls === 1)
      return page(
        [validItem, validItem],
        [
          {
            rel: "next",
            href: "/v1/search",
            method: "POST",
            body: { ...body, token: "next-page" },
          },
        ],
      );
    return page([validItem]);
  }).poll();
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.rawItemCount, 3);
  assert.equal(result.uniqueItemCount, 1);
  assert.equal(result.normalizedItemCount, 1);
});

test("pagination rejects cycles and unsafe origins", async () => {
  const cyclic = new MemoryDatabase();
  let calls = 0;
  await assert.rejects(
    service(cyclic, async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return page(
        [],
        [
          {
            rel: "next",
            href: "/v1/search",
            method: "POST",
            body: { ...body, token: "cycle" },
          },
        ],
      );
    }).poll(),
    (error: unknown) =>
      error instanceof Part8Error && error.code === "UNSAFE_PAGINATION",
  );
  assert.equal(calls, 2);
  assert.deepEqual(cyclic.failed, ["UNSAFE_PAGINATION"]);

  await assert.rejects(
    service(new MemoryDatabase(), async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return page(
        [],
        [
          {
            rel: "next",
            href: "https://example.invalid/v1/search",
            method: "POST",
            body: { ...body, token: "unsafe" },
          },
        ],
      );
    }).poll(),
    /UNSAFE_PAGINATION/u,
  );
});

test("retry policy honors bounded Retry-After and exponential jitter", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await service(
    new MemoryDatabase(),
    async () => {
      calls += 1;
      if (calls === 1) return page([], [], 429, { "retry-after": "30" });
      if (calls === 2) return page([], [], 503);
      return page([validItem]);
    },
    {},
    async (delay) => {
      delays.push(delay);
    },
  ).poll();
  assert.equal(result.normalizedItemCount, 1);
  assert.deepEqual(delays, [1_000, 100]);
});

test("timeouts stop at the retry limit and permanent 4xx is not retried", async () => {
  let timeoutCalls = 0;
  await assert.rejects(
    service(new MemoryDatabase(), async () => {
      timeoutCalls += 1;
      const error = new Error("synthetic timeout");
      error.name = "TimeoutError";
      throw error;
    }).poll(),
    (error: unknown) =>
      error instanceof Part8Error && error.code === "PROVIDER_TIMEOUT",
  );
  assert.equal(timeoutCalls, 3);

  let invalidCalls = 0;
  await assert.rejects(
    service(new MemoryDatabase(), async () => {
      invalidCalls += 1;
      return page([], [], 400);
    }).poll(),
    (error: unknown) =>
      error instanceof Part8Error && error.code === "INVALID_PROVIDER_RESPONSE",
  );
  assert.equal(invalidCalls, 1);
});

test("late products are found by a later overlapping poll", async () => {
  const database = new MemoryDatabase();
  let calls = 0;
  const discovery = service(database, async () => {
    calls += 1;
    return calls === 1 ? page([]) : page([validItem]);
  });
  assert.equal((await discovery.poll()).normalizedItemCount, 0);
  assert.equal((await discovery.poll()).normalizedItemCount, 1);
  assert.equal(database.completed.length, 2);
});

test("cron authentication rejects missing and incorrect secrets", async () => {
  const secret = "0123456789abcdef0123456789abcdef";
  assert.equal(await authenticateCron(null, secret), false);
  assert.equal(await authenticateCron("incorrect", secret), false);
  assert.equal(await authenticateCron(secret, secret), true);
  const edge = readFileSync(
    "supabase/functions/part8-discovery/index.ts",
    "utf8",
  );
  assert.match(edge, /request\.method !== "POST"/u);
  assert.match(edge, /x-discovery-secret/u);
  assert.doesNotMatch(edge, /x-user-id/iu);
});

const migrationFiles = [
  "20260925090921_part5_architecture_contracts.sql",
  "20261001090000_part6_aois_and_quota.sql",
  "20261001100000_part7_cdse_accounting.sql",
  "20261002214246_part8_stac_discovery.sql",
];

const createDatabase = async () => {
  const database = new PGlite({ extensions: { postgis, pgcrypto } });
  await database.exec(
    "create role anon; create role authenticated; create role service_role; create schema extensions;",
  );
  for (const file of migrationFiles)
    await database.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  return database;
};

const insertAoi = async (
  database: PGlite,
  aoiId: string,
  area: Record<string, unknown>,
  enabled = true,
  validTo: string | null = null,
) => {
  await database.query(
    `insert into app_private.aois (
      aoi_id, policy_version, aoi_name, area_geometry, enabled, priority,
      valid_from, valid_to, dry_run_month, estimated_scene_count,
      approximate_openeo_credits, cost_estimate_status, cost_estimate_method,
      cost_estimated_at, water_mask_source, coverage_status
    ) values (
      $1, '1.0.0', 'Synthetic test area',
      extensions.st_setsrid(extensions.st_geomfromgeojson($2::jsonb), 4326),
      $3, 'P1', '2026-01-01T00:00:00Z', $4::timestamptz,
      '2026-10-01', 1, 1, 'estimated', 'synthetic fixture',
      '2026-01-01T00:00:00Z', 'synthetic fixture', 'covered'
    )`,
    [aoiId, JSON.stringify(area), enabled, validTo],
  );
};

test("PostGIS ten-replay exit gate creates one scene and one job per overlap", async () => {
  const database = await createDatabase();
  const firstAoi = geometry;
  const secondAoi = {
    type: "Polygon",
    coordinates: [
      [
        [1, 0],
        [2, 0],
        [2, 2],
        [1, 2],
        [1, 0],
      ],
    ],
  };
  const touchingAoi = {
    type: "Polygon",
    coordinates: [
      [
        [1.5, 0.5],
        [2.5, 0.5],
        [2.5, 1.5],
        [1.5, 1.5],
        [1.5, 0.5],
      ],
    ],
  };
  await insertAoi(database, "aoi:first", firstAoi);
  await insertAoi(database, "aoi:second", secondAoi);
  await insertAoi(database, "aoi:touching", touchingAoi);
  await insertAoi(database, "aoi:disabled", firstAoi, false);
  await insertAoi(
    database,
    "aoi:expired",
    firstAoi,
    true,
    "2026-02-01T00:00:00Z",
  );
  const adapter = new SqlDiscoveryDatabase(database);
  const clock = Array.from(
    { length: 10 },
    (_, index) => new Date(Date.parse(instant) + index * 15 * 60_000),
  );
  for (let replay = 0; replay < 10; replay += 1) {
    const current = clock[replay]!;
    const result = await new DiscoveryService({
      database: adapter,
      fetcher: async () => page([validItem]),
      config: config(),
      now: () => current,
      random: () => 0,
      sleep: async () => undefined,
    }).poll();
    assert.equal(result.normalizedItemCount, 1);
    if (replay === 0) {
      assert.equal(result.createdSceneCount, 1);
      assert.equal(result.createdJobCount, 2);
      await database.query(
        `update app_private.processing_jobs
         set state = 'queued', queued_at = $1
         where aoi_id = 'aoi:first'`,
        [current.toISOString()],
      );
    }
  }
  const scenes = await database.query<{
    first_discovered_at: Date;
    last_discovered_at: Date;
  }>(
    "select first_discovered_at, last_discovered_at from app_private.scenes where collection = 'sentinel-1-grd'",
  );
  const jobs = await database.query<{ state: string; logical_count: number }>(
    `select min(state::text) as state, count(*)::integer as logical_count
     from app_private.processing_jobs`,
  );
  const duplicateJobs = await database.query(
    `select scene_id, aoi_id, preprocessing_version, model_version
     from app_private.processing_jobs group by 1, 2, 3, 4 having count(*) > 1`,
  );
  const polls = await database.query<{ count: number }>(
    "select count(*)::integer as count from app_private.discovery_poll_runs",
  );
  assert.equal(scenes.rows.length, 1);
  assert.equal(scenes.rows[0]?.first_discovered_at.toISOString(), instant);
  assert.equal(
    scenes.rows[0]?.last_discovered_at.toISOString(),
    clock[9]!.toISOString(),
  );
  assert.equal(jobs.rows[0]?.logical_count, 2);
  assert.equal(duplicateJobs.rows.length, 0);
  const queued = await database.query<{ state: string }>(
    "select state::text as state from app_private.processing_jobs where aoi_id = 'aoi:first'",
  );
  assert.equal(queued.rows[0]?.state, "queued");
  assert.equal(polls.rows[0]?.count, 10);
  await database.close();
});

test("PostGIS persistence handles missing VH, metadata updates, and concurrent replay", async () => {
  const database = await createDatabase();
  await insertAoi(database, "aoi:one", {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
        [0, 0],
      ],
    ],
  });
  const adapter = new SqlDiscoveryDatabase(database);
  const missing = await service(adapter, async () =>
    page([missingVhItem]),
  ).poll();
  assert.equal(missing.missingVhCount, 1);
  assert.equal(missing.createdJobCount, 0);

  const updated = structuredClone(validItem);
  updated.assets = {
    ...(updated.assets as Record<string, unknown>),
    preview: {
      href: "https://example.invalid/synthetic/preview.jpg",
      roles: ["thumbnail"],
    },
  };
  await service(adapter, async () => page([validItem])).poll();
  await Promise.all([
    service(adapter, async () => page([updated])).poll(),
    service(adapter, async () => page([updated])).poll(),
  ]);
  const rows = await database.query<{
    scene_count: number;
    job_count: number;
    asset_count: number;
  }>(
    `select
       (select count(*)::integer from app_private.scenes) as scene_count,
       (select count(*)::integer from app_private.processing_jobs) as job_count,
       (select jsonb_array_length(asset_references)
        from app_private.scenes where provider_scene_id = 'synthetic-iw-grd-001')
        as asset_count`,
  );
  assert.deepEqual(rows.rows[0], {
    scene_count: 2,
    job_count: 1,
    asset_count: 3,
  });
  await database.close();
});

test("migration keeps discovery private and schedules protected 15-minute calls", () => {
  const sql = readFileSync(
    "supabase/migrations/20261002214246_part8_stac_discovery.sql",
    "utf8",
  );
  assert.match(
    sql,
    /scenes_catalogue_identity_key[\s\S]*source_provider,[\s\S]*collection,[\s\S]*provider_scene_id/u,
  );
  assert.match(sql, /st_area\([\s\S]*st_intersection/u);
  assert.match(
    sql,
    /on conflict \([\s\S]*scene_id, aoi_id, preprocessing_version, model_version/u,
  );
  assert.match(sql, /cron\.schedule\(\$1, \$2, \$3\)/u);
  assert.match(sql, /'\*\/15 \* \* \* \*'/u);
  assert.match(sql, /part8_cron_secret/u);
  assert.doesNotMatch(sql, /insert\s+into\s+cron\.job/iu);
  assert.match(
    sql,
    /revoke all on function public\.record_part8_discovery_poll/u,
  );
});
