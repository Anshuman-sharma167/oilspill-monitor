import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const connection = process.env.PART9_POSTGRES_URL;
if (process.env.PART9_POSTGRES_DISPOSABLE !== "true" || !connection) {
  console.log(
    "SKIPPED: set PART9_POSTGRES_DISPOSABLE=true and PART9_POSTGRES_URL for an empty disposable PostgreSQL/PostGIS database.",
  );
  process.exit(0);
}

if (spawnSync("psql", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.log("SKIPPED: psql is unavailable.");
  process.exit(0);
}

const url = new URL(connection);
if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
  throw new Error("PART9_POSTGRES_URL must be a PostgreSQL URL");

const inherited = { ...process.env };
delete inherited.PART9_POSTGRES_URL;
const postgresEnvironment = {
  ...inherited,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGSSLMODE: url.searchParams.get("sslmode") ?? "prefer",
};

const psql = (sql) =>
  new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
      env: postgresEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(`PostgreSQL exit gate failed (${code}): ${stderr.trim()}`),
        );
    });
    child.stdin.end(sql);
  });

const migrationFiles = [
  "20260925090921_part5_architecture_contracts.sql",
  "20261001090000_part6_aois_and_quota.sql",
  "20261001100000_part7_cdse_accounting.sql",
  "20261002214246_part8_stac_discovery.sql",
  "20261003163000_part9_postgres_queue.sql",
];
const roleSetup = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;
create schema if not exists extensions;
`;
await psql(
  roleSetup +
    migrationFiles
      .map((file) => readFileSync(`supabase/migrations/${file}`, "utf8"))
      .join("\n"),
);

const job = (index) => `job:${index.toString(16).padStart(32, "0")}`;
await psql(`
insert into app_private.scenes
  (scene_id, source_provider, collection, provider_scene_id,
   first_discovered_at, last_discovered_at)
values ('scene:queue', 'synthetic', 'legacy', 'scene:queue', now(), now());
${Array.from({ length: 6 }, (_, index) => {
  const priority = index < 2 ? "P0" : index < 4 ? "P1" : "P2";
  return `insert into app_private.processing_jobs
    (job_id, scene_id, aoi_id, preprocessing_version, model_version,
     state, discovered_at, queued_at, priority)
    values ('${job(index + 1)}', 'scene:queue', 'aoi:${index}', '1.0.0',
      '1.0.0', 'queued', now() - interval '${10 - index} minutes',
      now() - interval '${10 - index} minutes', '${priority}');`;
}).join("\n")}
`);

const claimed = (
  await Promise.all(
    Array.from({ length: 18 }, (_, index) =>
      psql(
        `select coalesce((select job_id from app_private.claim_processing_job('worker:${index}', 60, now())), '');`,
      ),
    ),
  )
).filter(Boolean);
assert(claimed.length === 6, "six jobs must be claimed");
assert(
  new Set(claimed).size === 6,
  "concurrent claimers must not duplicate jobs",
);

await psql(`
truncate app_private.processing_jobs cascade;
truncate app_private.scenes cascade;
insert into app_private.scenes
  (scene_id, source_provider, collection, provider_scene_id,
   first_discovered_at, last_discovered_at)
values ('scene:crash', 'synthetic', 'legacy', 'scene:crash', now(), now());
insert into app_private.processing_jobs
  (job_id, scene_id, aoi_id, preprocessing_version, model_version,
   state, discovered_at, queued_at, priority)
values ('${job(20)}', 'scene:crash', 'aoi:crash', '1.0.0', '1.0.0',
  'queued', now(), now(), 'P0');
select * from app_private.claim_processing_job('worker:crash-one', 60, '2026-10-03T12:00:00Z');
select app_private.recover_expired_processing_job(
  '${job(20)}', claim_token, 'not_submitted', 1, '2026-10-03T12:01:01Z'
) from app_private.processing_jobs where job_id = '${job(20)}';
do $$ begin
  if (select state <> 'queued' from app_private.processing_jobs where job_id = '${job(20)}') then
    raise exception 'claim crash did not requeue';
  end if;
end $$;
`);

await psql(`
insert into app_private.aois (
  aoi_id, policy_version, aoi_name, area_geometry, enabled, priority,
  valid_from, dry_run_month, estimated_scene_count, approximate_openeo_credits,
  cost_estimate_status, cost_estimate_method, cost_estimated_at,
  water_mask_source, coverage_status
) values (
  'aoi:provider', '1.0.0', 'Synthetic',
  extensions.st_geomfromtext('POLYGON((0 0,1 0,1 1,0 1,0 0))', 4326),
  true, 'P0', '2026-01-01', '2026-10-01', 1, 1, 'estimated',
  'synthetic', '2026-01-01', 'synthetic', 'covered'
);
insert into app_private.processing_jobs
  (job_id, scene_id, aoi_id, preprocessing_version, model_version,
   state, discovered_at, queued_at, priority)
values ('${job(21)}', 'scene:crash', 'aoi:provider', '1.0.0', '1.0.0',
  'queued', now(), now(), 'P0');
select * from app_private.claim_processing_job('worker:crash-two', 60, '2026-10-03T12:00:00Z');
insert into app_private.provider_job_runs (
  job_id, provider_job_id, aoi_id, policy_version, graph_version, priority,
  allocation_bucket, accounting_month, state, estimate_credits,
  estimate_provenance, decision_reason, decision_at, submitted_at
) values (
  '${job(21)}', 'provider-synthetic-one', 'aoi:provider', '1.0.0', '1.0.0',
  'P0', 'priority', '2026-10', 'running', 1, 'estimated', 'synthetic',
  '2026-10-03T12:00:00Z', '2026-10-03T12:00:00Z'
);
select app_private.recover_expired_processing_job(
  '${job(21)}', claim_token, 'running', 1, '2026-10-03T12:01:01Z'
) from app_private.processing_jobs where job_id = '${job(21)}';
do $$ begin
  if (select provider_job_id <> 'provider-synthetic-one'
      from app_private.processing_jobs where job_id = '${job(21)}') then
    raise exception 'provider submission was not preserved';
  end if;
  if (select count(*) <> 1 from app_private.provider_job_runs where job_id = '${job(21)}') then
    raise exception 'provider submission duplicated';
  end if;
end $$;
`);

await psql(`
insert into app_private.processing_jobs
  (job_id, scene_id, aoi_id, preprocessing_version, model_version,
   state, discovered_at, queued_at, priority)
values ('${job(22)}', 'scene:crash', 'aoi:checkpoint', '1.0.0', '1.0.0',
  'queued', now(), now(), 'P0');
select * from app_private.claim_processing_job('worker:crash-three', 60, '2026-10-03T12:00:00Z');
select app_private.advance_processing_job(
  '${job(22)}', claim_token, 'inferencing', '2026-10-03T12:00:15Z'
) from app_private.processing_jobs where job_id = '${job(22)}';
select app_private.complete_processing_stage(
  '${job(22)}', claim_token, 'asset_upload', '1.0.0', repeat('a', 64),
  '{"synthetic":true}'::jsonb, '2026-10-03T12:00:30Z'
) from app_private.processing_jobs where job_id = '${job(22)}';
select app_private.recover_expired_processing_job(
  '${job(22)}', claim_token, 'not_submitted', 1, '2026-10-03T12:01:01Z'
) from app_private.processing_jobs where job_id = '${job(22)}';
select * from app_private.claim_processing_job('worker:resume', 60, '2026-10-03T12:01:02Z');
select app_private.advance_processing_job(
  '${job(22)}', claim_token, 'inferencing', '2026-10-03T12:01:02Z'
) from app_private.processing_jobs where job_id = '${job(22)}';
select app_private.complete_processing_stage(
  '${job(22)}', claim_token, 'asset_upload', '1.0.0', repeat('a', 64),
  '{"synthetic":true}'::jsonb, '2026-10-03T12:01:03Z'
) from app_private.processing_jobs where job_id = '${job(22)}';
do $$ begin
  if (select count(*) <> 1 from app_private.processing_stage_checkpoints where job_id = '${job(22)}') then
    raise exception 'checkpoint duplicated';
  end if;
end $$;
`);

console.log(
  `PASS: ${claimed.length} jobs were claimed once across 18 PostgreSQL sessions; all three crash recovery checks passed.`,
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
