import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import {
  alertDeliveryId,
  candidateId,
  ensureAlertDelivery,
  ensureProcessingJob,
  processingJobId,
  upsertDiscoveredScene,
  validateContract,
  type AlertDelivery,
  type ContractModelName,
  type ProcessingJob,
  type Scene,
} from "../../packages/schemas/src/index.js";

const valid = JSON.parse(
  readFileSync("data/fixtures/contracts/valid.json", "utf8"),
) as Record<ContractModelName, unknown>;
const invalid = JSON.parse(
  readFileSync("data/fixtures/contracts/invalid.json", "utf8"),
) as Array<{ name: string; model: ContractModelName; payload: unknown }>;

test("validates every representative contract payload", () => {
  for (const [model, payload] of Object.entries(valid)) {
    assert.doesNotThrow(() =>
      validateContract(model as ContractModelName, payload),
    );
  }
});

test("rejects invalid geometry, CRS, state, failure, and asset fixtures", () => {
  for (const fixture of invalid) {
    assert.throws(
      () => validateContract(fixture.model, fixture.payload),
      { name: "Error" },
      fixture.name,
    );
  }
});

test("validates every versioned asset layout", () => {
  const base = valid.CandidateAsset as Record<string, unknown>;
  const layouts = {
    context_webp: "image/webp",
    detail_webp: "image/webp",
    probability_cog: "image/tiff; application=geotiff",
    mask_cog: "image/tiff; application=geotiff",
    report_json: "application/json",
  };
  for (const [assetType, mediaType] of Object.entries(layouts)) {
    assert.doesNotThrow(() =>
      validateContract("CandidateAsset", {
        ...base,
        asset_id: `asset:${assetType}`,
        asset_type: assetType,
        media_type: mediaType,
      }),
    );
  }
});

test("job identity is unique across exactly its four immutable inputs", () => {
  const base = processingJobId("scene:one", "aoi:one", "1.0.0", "2.0.0");
  assert.equal(base, processingJobId("scene:one", "aoi:one", "1.0.0", "2.0.0"));
  assert.notEqual(
    base,
    processingJobId("scene:two", "aoi:one", "1.0.0", "2.0.0"),
  );
  assert.notEqual(
    base,
    processingJobId("scene:one", "aoi:two", "1.0.0", "2.0.0"),
  );
  assert.notEqual(
    base,
    processingJobId("scene:one", "aoi:one", "1.0.1", "2.0.0"),
  );
  assert.notEqual(
    base,
    processingJobId("scene:one", "aoi:one", "1.0.0", "2.0.1"),
  );
});

test("candidate identity remains stable after reranking", () => {
  const before = candidateId("job:one", "detection:shape-one");
  const displayRank = 1;
  const rerankedDisplayRank = 9;
  assert.notEqual(displayRank, rerankedDisplayRank);
  assert.equal(before, candidateId("job:one", "detection:shape-one"));
});

test("repeated discovery upserts one scene", () => {
  const scenes = new Map<string, Scene>();
  const first = structuredClone(valid.Scene) as Scene;
  const rediscovered = {
    ...first,
    last_discovered_at: "2026-01-01T00:02:00.000Z",
  };
  assert.equal(upsertDiscoveredScene(scenes, first), first);
  assert.equal(upsertDiscoveredScene(scenes, rediscovered), first);
  assert.equal(scenes.size, 1);
  assert.equal(first.last_discovered_at, rediscovered.last_discovered_at);
});

test("retried workers return the existing immutable job", () => {
  const jobs = new Map<string, ProcessingJob>();
  const source = valid.ProcessingJob as ProcessingJob;
  const job = {
    ...source,
    job_id: processingJobId(
      source.scene_id,
      source.aoi_id,
      source.preprocessing_version,
      source.model_version,
    ),
  };
  assert.equal(ensureProcessingJob(jobs, job), job);
  assert.equal(ensureProcessingJob(jobs, structuredClone(job)), job);
  assert.equal(jobs.size, 1);
});

test("repeated alert approval returns the existing delivery", () => {
  const deliveries = new Map<string, AlertDelivery>();
  const source = valid.AlertDelivery as AlertDelivery;
  const delivery = {
    ...source,
    delivery_id: alertDeliveryId(
      source.candidate_id,
      source.review_id,
      source.channel,
    ),
  };
  assert.equal(ensureAlertDelivery(deliveries, delivery), delivery);
  assert.equal(
    ensureAlertDelivery(deliveries, structuredClone(delivery)),
    delivery,
  );
  assert.equal(deliveries.size, 1);
});

test("migration enforces the database identity and idempotency keys", () => {
  const migration = readdirSync("supabase/migrations").find((name) =>
    name.endsWith("_part5_architecture_contracts.sql"),
  );
  assert.ok(migration);
  const sql = readFileSync(`supabase/migrations/${migration}`, "utf8");
  assert.match(
    sql,
    /unique\s*\(\s*scene_id,\s*aoi_id,\s*preprocessing_version,\s*model_version\s*\)/su,
  );
  assert.match(sql, /reject_processing_job_identity_change/u);
  assert.match(sql, /unique\s*\(job_id, detection_key\)/u);
  assert.match(
    sql,
    /unique\s*\(\s*candidate_id,\s*review_id,\s*channel\s*\)/su,
  );
});

test("migration executes and rejects duplicate or mutated identities", async () => {
  const migration = readdirSync("supabase/migrations").find((name) =>
    name.endsWith("_part5_architecture_contracts.sql"),
  );
  assert.ok(migration);
  const database = new PGlite();
  await database.exec("create role anon; create role authenticated;");
  await database.exec(readFileSync(`supabase/migrations/${migration}`, "utf8"));
  await database.exec(`
    insert into app_private.scenes (
      scene_id, source_provider, provider_scene_id,
      first_discovered_at, last_discovered_at
    ) values (
      'scene:one', 'synthetic-provider', 'synthetic-scene-one',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    );
    insert into app_private.processing_jobs (
      job_id, scene_id, aoi_id, preprocessing_version, model_version,
      state, discovered_at
    ) values (
      'job:one', 'scene:one', 'aoi:one', '1.0.0', '1.0.0',
      'discovered', '2026-01-01T00:00:00Z'
    );
  `);
  await assert.rejects(
    database.exec(`
      insert into app_private.processing_jobs (
        job_id, scene_id, aoi_id, preprocessing_version, model_version,
        state, discovered_at
      ) values (
        'job:duplicate', 'scene:one', 'aoi:one', '1.0.0', '1.0.0',
        'discovered', '2026-01-01T00:00:00Z'
      );
    `),
    /unique/u,
  );
  await assert.rejects(
    database.exec(
      "update app_private.processing_jobs set model_version = '2.0.0' where job_id = 'job:one';",
    ),
    /immutable/u,
  );
  await database.exec(`
    insert into app_private.candidates (
      candidate_id, job_id, detection_key, display_rank
    ) values ('candidate:one', 'job:one', 'detection:one', 1);
    update app_private.candidates
      set display_rank = 7
      where candidate_id = 'candidate:one';
    insert into app_private.alert_deliveries (
      delivery_id, candidate_id, review_id, channel, approved_at
    ) values (
      'delivery:one', 'candidate:one', 'review:one', 'telegram',
      '2026-01-01T00:10:00Z'
    );
  `);
  const reranked = await database.query<{
    candidate_id: string;
    display_rank: number;
  }>("select candidate_id, display_rank from app_private.candidates;");
  assert.deepEqual(reranked.rows, [
    { candidate_id: "candidate:one", display_rank: 7 },
  ]);
  await assert.rejects(
    database.exec(`
      insert into app_private.alert_deliveries (
        delivery_id, candidate_id, review_id, channel, approved_at
      ) values (
        'delivery:duplicate', 'candidate:one', 'review:one', 'telegram',
        '2026-01-01T00:10:00Z'
      );
    `),
    /unique/u,
  );
  await database.close();
});
