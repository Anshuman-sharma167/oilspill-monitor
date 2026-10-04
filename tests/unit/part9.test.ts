import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { postgis } from "@electric-sql/pglite-postgis";

import { GitHubJobDispatcher } from "../../services/worker/src/part9-github-dispatch.js";
import {
  Part9Error,
  Part9Recovery,
  Part9Worker,
  classifyError,
  readPart9Config,
  retryDelaySeconds,
  type ClaimedJob,
  type ExpiredLease,
  type JobState,
  type Part9Queue,
  type ProviderRecoveryStatus,
  type RecoveryQueue,
  type StageName,
} from "../../services/worker/src/part9.js";

const instant = new Date("2026-10-03T12:00:00.000Z");
const migrations = [
  "20260925090921_part5_architecture_contracts.sql",
  "20261001090000_part6_aois_and_quota.sql",
  "20261001100000_part7_cdse_accounting.sql",
  "20261002214246_part8_stac_discovery.sql",
  "20261003163000_part9_postgres_queue.sql",
];

test("Part 9 configuration and error policy are bounded and centralized", () => {
  assert.deepEqual(readPart9Config({}), {
    workerId: "worker:local",
    leaseSeconds: 300,
    retryBaseSeconds: 30,
    retryMaxSeconds: 1800,
    stageVersion: "1.0.0",
  });
  assert.throws(
    () => readPart9Config({ PART9_LEASE_SECONDS: "99999" }),
    /PART9_LEASE_SECONDS/u,
  );
  for (const code of [
    "NETWORK_TIMEOUT",
    "TEMPORARY_PROVIDER_FAILURE",
    "GITHUB_TRANSIENT_FAILURE",
    "TEMPORARY_STORAGE_FAILURE",
    "WORKER_INTERRUPTED",
  ] as const)
    assert.equal(new Part9Error(code).retryable, true);
  for (const code of [
    "UNSUPPORTED_POLARIZATION",
    "INVALID_GEOMETRY",
    "CONTRACT_VALIDATION_FAILED",
    "CORRUPTED_OUTPUT",
    "INVALID_CONFIGURATION",
  ] as const)
    assert.equal(new Part9Error(code).retryable, false);
  assert.equal(
    classifyError(new Error("private token=x")).message,
    "UNCLASSIFIED_WORKER_FAILURE",
  );
  assert.equal(
    retryDelaySeconds(1, 30, 300, () => 0),
    15,
  );
  assert.equal(
    retryDelaySeconds(20, 30, 300, () => 0.999),
    300,
  );
});

class MemoryQueue implements Part9Queue, RecoveryQueue {
  state: JobState = "queued";
  attempts = 0;
  maxAttempts = 3;
  token = "00000000-0000-4000-8000-000000000001";
  providerJobId: string | null = null;
  expiredLease: ExpiredLease | null = null;
  checkpoints = new Map<string, string>();
  providerSubmissions = 0;
  candidates = new Set<string>();
  alerts = new Set<string>();
  renewals = 0;

  async claim(_worker: string, _seconds: number, now: Date) {
    if (this.state !== "queued") return null;
    this.state = "preprocessing";
    this.attempts += 1;
    return {
      jobId: "job:00000000000000000000000000000001",
      state: "preprocessing" as const,
      attemptCount: this.attempts,
      maxAttempts: this.maxAttempts,
      claimToken: this.token,
      leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString(),
      providerJobId: this.providerJobId,
    };
  }

  async renew(_job: string, token: string) {
    this.renewals += 1;
    return (
      token === this.token &&
      ["preprocessing", "inferencing"].includes(this.state)
    );
  }

  async checkpoint(
    _job: string,
    token: string,
    stage: StageName,
    version: string,
    checksum: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
    now: Date,
  ) {
    void metadata;
    void now;
    if (token !== this.token) throw new Error("STALE_JOB_CLAIM");
    const key = `${stage}:${version}`;
    const existing = this.checkpoints.get(key);
    if (existing && existing !== checksum)
      throw new Part9Error("CORRUPTED_OUTPUT");
    this.checkpoints.set(key, checksum);
    return { reused: existing === checksum };
  }

  async advance(
    _job: string,
    token: string,
    target: "inferencing" | "ready_for_review",
  ) {
    if (token !== this.token) return false;
    this.state = target;
    return true;
  }

  async fail(_job: string, token: string, error: Part9Error) {
    if (token !== this.token) throw new Error("STALE_JOB_CLAIM");
    this.state =
      error.retryable && this.attempts < this.maxAttempts ? "queued" : "failed";
    return this.state as "queued" | "failed";
  }

  async expired() {
    return this.expiredLease ? [this.expiredLease] : [];
  }

  async recover(
    lease: ExpiredLease,
    status: ProviderRecoveryStatus,
  ): Promise<JobState> {
    if (lease.claimToken !== this.token) throw new Error("STALE_JOB_CLAIM");
    if (
      ["queued", "running", "finished", "unavailable", "ambiguous"].includes(
        status,
      )
    ) {
      this.state = status === "finished" ? "inferencing" : "preprocessing";
      return this.state;
    }
    this.state =
      status === "canceled" || this.attempts >= this.maxAttempts
        ? "failed"
        : "queued";
    return this.state;
  }
}

const claimed = (): ClaimedJob => ({
  jobId: "job:00000000000000000000000000000001",
  state: "preprocessing",
  attemptCount: 1,
  maxAttempts: 3,
  claimToken: "00000000-0000-4000-8000-000000000001",
  leaseExpiresAt: "2026-10-03T12:05:00.000Z",
  providerJobId: null,
});

test("worker reuses checkpoints and sends terminal work to review", async () => {
  const queue = new MemoryQueue();
  const worker = new Part9Worker(
    queue,
    {
      preprocessing: async () => ({
        bytes: Buffer.from("synthetic-preprocess"),
      }),
      inferencing: async () => ({ bytes: Buffer.from("synthetic-inference") }),
    },
    readPart9Config({}),
    () => instant,
    () => 0,
  );
  assert.equal(await worker.runOne(), "completed");
  assert.equal(queue.state, "ready_for_review");
  assert.equal(queue.renewals, 2);
  assert.equal(queue.checkpoints.size, 2);
  const preprocessingChecksum = queue.checkpoints.get("preprocessing:1.0.0");
  queue.state = "queued";
  assert.equal(await worker.runOne(), "completed");
  assert.equal(queue.renewals, 4);
  assert.equal(
    queue.checkpoints.get("preprocessing:1.0.0"),
    preprocessingChecksum,
  );
  assert.equal(queue.checkpoints.size, 2);
});

test("retryable failures back off and permanent or exhausted failures are visible", async () => {
  const queue = new MemoryQueue();
  const retrying = new Part9Worker(
    queue,
    {
      preprocessing: async () => {
        throw new Part9Error("NETWORK_TIMEOUT");
      },
      inferencing: async () => ({ bytes: new Uint8Array() }),
    },
    readPart9Config({}),
    () => instant,
    () => 0,
  );
  assert.equal(await retrying.runOne(), "queued");
  queue.state = "queued";
  queue.attempts = 2;
  assert.equal(await retrying.runOne(), "failed");

  const permanent = new MemoryQueue();
  const failing = new Part9Worker(
    permanent,
    {
      preprocessing: async () => {
        throw new Part9Error("INVALID_GEOMETRY");
      },
      inferencing: async () => ({ bytes: new Uint8Array() }),
    },
    readPart9Config({}),
    () => instant,
    () => 0,
  );
  assert.equal(await failing.runOne(), "failed");
});

test("all three crash points recover without duplicate durable effects", async () => {
  const queue = new MemoryQueue();
  const recovery = (status: ProviderRecoveryStatus) =>
    new Part9Recovery(
      queue,
      {
        status: async () =>
          status as Exclude<ProviderRecoveryStatus, "not_submitted">,
      },
      readPart9Config({}),
      () => instant,
      () => 0,
    );

  queue.state = "preprocessing";
  queue.providerJobId = "provider-job-unknown";
  queue.expiredLease = {
    ...claimed(),
    attemptCount: 1,
    providerJobId: queue.providerJobId,
  };
  assert.equal(
    (await recovery("unavailable").run())[0]?.state,
    "preprocessing",
  );

  queue.state = "preprocessing";
  queue.providerJobId = "provider-job-one";
  queue.providerSubmissions = 1;
  queue.expiredLease = {
    ...claimed(),
    attemptCount: 1,
    providerJobId: queue.providerJobId,
  };
  assert.equal((await recovery("running").run())[0]?.state, "preprocessing");
  assert.equal(queue.providerSubmissions, 1);

  await queue.checkpoint(
    claimed().jobId,
    queue.token,
    "asset_upload",
    "1.0.0",
    "a".repeat(64),
    {},
    instant,
  );
  queue.candidates.add("candidate:one");
  queue.alerts.add("candidate:one:review:one:telegram");
  queue.state = "preprocessing";
  assert.equal((await recovery("finished").run())[0]?.state, "inferencing");
  const replay = await queue.checkpoint(
    claimed().jobId,
    queue.token,
    "asset_upload",
    "1.0.0",
    "a".repeat(64),
    {},
    instant,
  );
  assert.equal(replay.reused, true);
  assert.equal(queue.checkpoints.size, 1);
  assert.equal(queue.candidates.size, 1);
  assert.equal(queue.alerts.size, 1);
});

test("GitHub dispatcher mints a short-lived token and sends only job_id", async () => {
  const bodies: unknown[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1)
      return new Response(
        JSON.stringify({ token: "installation-token-value" }),
        { status: 201 },
      );
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const dispatcher = new GitHubJobDispatcher(
    {
      owner: "synthetic-owner",
      repository: "synthetic-repo",
      workflow: "part9-process-job.yml",
      ref: "main",
      appId: "123",
      installationId: "456",
      privateKey: "synthetic-key-placeholder",
      enabled: true,
    },
    fetcher,
    () => 1_800_000_000,
    () => "synthetic-jwt-placeholder",
  );
  const jobId = "job:00000000000000000000000000000001";
  await dispatcher.dispatch(jobId);
  assert.deepEqual(bodies[0], { permissions: { actions: "write" } });
  assert.deepEqual(bodies[1], { ref: "main", inputs: { job_id: jobId } });
  assert.deepEqual(Object.keys((bodies[1] as { inputs: object }).inputs), [
    "job_id",
  ]);
  await assert.rejects(dispatcher.dispatch("$(unsafe)"), /INVALID_JOB_ID/u);
});

test("migration applies in order and enforces queue, leases, transitions, and checkpoints", async () => {
  const database = new PGlite({ extensions: { postgis, pgcrypto } });
  await database.exec(
    "create role anon; create role authenticated; create role service_role; create schema extensions;",
  );
  for (const migration of migrations)
    await database.exec(
      readFileSync(`supabase/migrations/${migration}`, "utf8"),
    );

  await database.query(
    `insert into app_private.scenes
     (scene_id, source_provider, collection, provider_scene_id,
      first_discovered_at, last_discovered_at)
     values ($1, 'synthetic', 'legacy', $1, $2, $2),
            ($3, 'synthetic', 'legacy', $3, $2, $2)`,
    ["scene:one", instant.toISOString(), "scene:two"],
  );
  const insertJob = async (
    id: string,
    scene: string,
    priority: "P0" | "P1" | "P2",
    queuedAt: string,
    nextAttemptAt: string | null = null,
    state: JobState = "queued",
    attemptCount = 0,
    maxAttempts = 3,
  ) =>
    database.query(
      `insert into app_private.processing_jobs
       (job_id, scene_id, aoi_id, preprocessing_version, model_version,
        state, discovered_at, queued_at, priority, next_attempt_at,
        attempt_count, max_attempts, deferred_quota_at)
       values ($1, $2, $1, '1.0.0', '1.0.0',
         $3::app_private.processing_job_state, $4, $4, $5, $6, $7, $8,
         case when $3::text = 'deferred_quota' then $4::timestamptz else null end)`,
      [
        id,
        scene,
        state,
        queuedAt,
        priority,
        nextAttemptAt,
        attemptCount,
        maxAttempts,
      ],
    );
  await insertJob("job:p2", "scene:one", "P2", "2026-10-03T10:00:00Z");
  await insertJob("job:p0b", "scene:one", "P0", "2026-10-03T11:00:00Z");
  await insertJob("job:p0a", "scene:two", "P0", "2026-10-03T11:00:00Z");
  await insertJob(
    "job:future",
    "scene:two",
    "P0",
    "2026-10-03T09:00:00Z",
    "2026-10-03T13:00:00Z",
  );
  await insertJob(
    "job:exhausted",
    "scene:two",
    "P0",
    "2026-10-03T08:00:00Z",
    null,
    "queued",
    2,
    2,
  );
  await insertJob(
    "job:deferred",
    "scene:one",
    "P0",
    "2026-10-03T07:00:00Z",
    null,
    "deferred_quota",
  );

  const claims = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      database.query<{
        job_id: string;
        claim_token: string;
        lease_expires_at: Date;
      }>(
        "select job_id, claim_token::text, lease_expires_at from app_private.claim_processing_job($1, 300, $2)",
        [`worker:${index}`, instant.toISOString()],
      ),
    ),
  );
  const claimedIds = claims.flatMap((result) =>
    result.rows.map((row) => row.job_id),
  );
  assert.deepEqual(claimedIds, ["job:p0a", "job:p0b", "job:p2"]);
  assert.equal(new Set(claimedIds).size, claimedIds.length);
  for (const result of claims)
    for (const row of result.rows)
      assert.equal(
        row.lease_expires_at.toISOString(),
        "2026-10-03T12:05:00.000Z",
      );

  const first = claims.find((result) => result.rows[0]?.job_id === "job:p0a")!
    .rows[0]!;
  const illegalAdvance = await database.query<{ advanced: boolean }>(
    "select app_private.advance_processing_job('job:p0a', $1, 'ready_for_review', $2) as advanced",
    [first.claim_token, instant.toISOString()],
  );
  assert.equal(illegalAdvance.rows[0]?.advanced, false);
  const checksum = "a".repeat(64);
  await database.query(
    "select app_private.complete_processing_stage('job:p0a', $1, 'preprocessing', '1.0.0', $2, '{}'::jsonb, $3)",
    [first.claim_token, checksum, instant.toISOString()],
  );
  await database.query(
    "select app_private.complete_processing_stage('job:p0a', $1, 'preprocessing', '1.0.0', $2, '{}'::jsonb, $3)",
    [first.claim_token, checksum, instant.toISOString()],
  );
  await assert.rejects(
    database.query(
      "select app_private.complete_processing_stage('job:p0a', $1, 'asset_upload', '1.0.0', $2, '{}'::jsonb, $3)",
      [first.claim_token, checksum, instant.toISOString()],
    ),
    /STALE_JOB_CLAIM/u,
  );
  await assert.rejects(
    database.query(
      "select app_private.complete_processing_stage('job:p0a', $1, 'preprocessing', '1.0.0', $2, '{}'::jsonb, $3)",
      [first.claim_token, "b".repeat(64), instant.toISOString()],
    ),
    /CORRUPTED_OUTPUT/u,
  );
  await assert.rejects(
    database.query(
      "select app_private.complete_processing_stage('job:p0a', $1, 'asset_upload', '1.0.0', $2, '{}'::jsonb, $3)",
      ["00000000-0000-4000-8000-000000000099", checksum, instant.toISOString()],
    ),
    /STALE_JOB_CLAIM/u,
  );
  const checkpointCount = await database.query<{ count: number }>(
    "select count(*)::integer as count from app_private.processing_stage_checkpoints where job_id = 'job:p0a'",
  );
  assert.equal(checkpointCount.rows[0]?.count, 1);

  const retried = await database.query<{ state: string }>(
    "select app_private.fail_processing_job('job:p0a', $1, 'NETWORK_TIMEOUT', 'NETWORK_TIMEOUT', true, 30, $2)::text as state",
    [first.claim_token, instant.toISOString()],
  );
  assert.equal(retried.rows[0]?.state, "queued");
  const staleRenewal = await database.query<{ renewed: boolean }>(
    "select app_private.renew_processing_job_lease('job:p0a', $1, 300, $2) as renewed",
    [first.claim_token, instant.toISOString()],
  );
  assert.notEqual(staleRenewal.rows[0]?.renewed, true);

  await assert.rejects(
    database.query(
      "update app_private.processing_jobs set state = 'ready_for_review' where job_id = 'job:p2'",
    ),
    /ILLEGAL_JOB_STATE_TRANSITION/u,
  );
  await assert.rejects(
    database.query(
      "update app_private.processing_jobs set state = 'queued' where job_id = 'job:deferred'",
    ),
    /QUOTA_READMISSION_REQUIRED/u,
  );
  const grants = await database.query<{ role_name: string }>(
    `select grantee as role_name from information_schema.routine_privileges
     where routine_schema = 'app_private'
       and routine_name = 'claim_processing_job'
       and grantee in ('anon', 'authenticated')`,
  );
  assert.equal(grants.rows.length, 0);
  await database.close();
});

test("workflow has one caller input, minimum permissions, pinning, and fail-closed dispatch", () => {
  const workflow = readFileSync(
    ".github/workflows/part9-process-job.yml",
    "utf8",
  );
  const inputBlock =
    workflow.match(/inputs:\s*([\s\S]*?)\npermissions:/u)?.[1] ?? "";
  assert.deepEqual(
    [...inputBlock.matchAll(/^([a-z_]+):\r?$/gmu)].map((match) => match[1]),
    ["job_id"],
  );
  assert.match(workflow, /contents: read/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /PART9_LIVE_DISPATCH_ENABLED/u);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/u);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/u);
  assert.doesNotMatch(
    workflow,
    /pull-requests: write|contents: write|secrets\./u,
  );

  const sql = readFileSync(
    "supabase/migrations/20261003163000_part9_postgres_queue.sql",
    "utf8",
  );
  assert.match(sql, /for update skip locked/iu);
  assert.match(sql, /processing_jobs_claim_queue/u);
  assert.match(sql, /set search_path = ''/gu);
  assert.match(sql, /revoke execute on all functions in schema app_private/iu);
  assert.match(sql, /content_checksum ~ '\^\[0-9a-f\]\{64\}\$'/u);
});
