import { createHash } from "node:crypto";

import { sceneId } from "../../../packages/schemas/src/identity.js";

import {
  CdseProvider,
  decideDispatch,
  minimalJobDefinition,
  ProviderError,
  readPart7Config,
  type AllocationBucket,
  type PilotJob,
  type UsageCache,
  type UsageSnapshot,
} from "./part7.js";

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

const entryId = (jobId: string, event: string): string =>
  `credit:${createHash("sha256").update(`${jobId}\u001f${event}`).digest("hex").slice(0, 32)}`;

async function transaction<T>(
  client: SqlClient,
  work: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    const result = await work();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export class Part7Dispatch {
  constructor(
    private readonly database: SqlClient,
    private readonly usage: Pick<UsageCache, "current"> &
      Partial<Pick<UsageCache, "invalidate">>,
    private readonly provider: Pick<
      CdseProvider,
      | "createJob"
      | "startJob"
      | "jobStatus"
      | "resultSize"
      | "verifyCollection"
      | "verifyStac"
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly dispatchEnabled = readPart7Config().dispatchEnabled,
    private readonly config = readPart7Config(),
  ) {}

  async reserve(job: PilotJob, estimate: number, bucket: AllocationBucket) {
    return this.reserveInternal(job, estimate, bucket, false);
  }

  async reconsider(job: PilotJob, estimate: number, bucket: AllocationBucket) {
    return this.reserveInternal(job, estimate, bucket, true);
  }

  private async reserveInternal(
    job: PilotJob,
    estimate: number,
    bucket: AllocationBucket,
    reconsider: boolean,
  ) {
    // Validate the immutable identity and the tiny verification graph before
    // creating any reservation or billable provider request.
    minimalJobDefinition(job, this.config.collectionId, this.config.bands);
    let usage: UsageSnapshot | null;
    try {
      usage = await this.usage.current();
    } catch {
      usage = null;
    }
    return transaction(this.database, async () => {
      const existing = await this.database.query<{ state: string }>(
        "select state from app_private.provider_job_runs where job_id = $1 for update",
        [job.localJobId],
      );
      if (
        existing.rows[0] &&
        (!reconsider || existing.rows[0].state !== "deferred_quota")
      )
        return existing.rows[0].state;
      if (reconsider && !existing.rows[0])
        throw new Error("PART7_DEFERRED_JOB_MISSING");
      const policy = await this.database.query<{ policy_version: string }>(
        "select policy_version from app_private.monthly_credit_policies where policy_version = $1 for update",
        [job.policyVersion],
      );
      if (!policy.rows[0]) throw new Error("PART7_POLICY_MISSING");
      const source = await this.database.query<{
        state: string;
        enabled: boolean;
        priority: string;
      }>(
        `select p.state, a.enabled, a.priority::text from app_private.processing_jobs p
         join app_private.aois a on a.aoi_id = p.aoi_id and a.policy_version = $2
         where p.job_id = $1 and p.aoi_id = $3 for update of p`,
        [job.localJobId, job.policyVersion, job.aoiId],
      );
      if (
        !source.rows[0] ||
        !source.rows[0].enabled ||
        source.rows[0].priority !== job.priority ||
        source.rows[0].state !== (reconsider ? "deferred_quota" : "queued")
      )
        throw new Error("PART7_JOB_NOT_ELIGIBLE");
      const month = this.now().toISOString().slice(0, 7);
      const reserved = await this.database.query<{
        total: string;
        bucket: string;
      }>(
        `select coalesce(sum(case when state in
                  ('reserved', 'submitting', 'submitted', 'queued', 'running', 'ambiguous')
                  then estimate_credits else coalesce(actual_credits, estimate_credits) end), 0)::text as total,
                coalesce(sum(case when allocation_bucket = $2 then
                  case when state in
                    ('reserved', 'submitting', 'submitted', 'queued', 'running', 'ambiguous')
                    then estimate_credits else coalesce(actual_credits, estimate_credits) end
                  else 0 end), 0)::text as bucket
         from app_private.provider_job_runs
         where accounting_month = $1 and
           (state in ('reserved', 'submitting', 'submitted', 'queued', 'running', 'ambiguous')
            or completed_at > $3::timestamptz)`,
        [month, bucket, usage?.fetchedAt ?? `${month}-01T00:00:00.000Z`],
      );
      const release = await this.database.query<{ reviewer_id: string }>(
        `select reviewer_id from app_private.reviewer_releases
         where job_id = $1 and policy_version = $2
           and condition_code = 'USAGE_UNAVAILABLE'`,
        [job.localJobId, job.policyVersion],
      );
      const decisionAt = this.now().toISOString();
      const decision = decideDispatch({
        priority: job.priority,
        bucket,
        estimate,
        reservedTotal: Number(reserved.rows[0]?.total ?? 0),
        reservedBucket: Number(reserved.rows[0]?.bucket ?? 0),
        usage,
        reviewerRelease: !!release.rows[0],
        now: decisionAt,
        maxSnapshotAgeMs: this.config.usageCacheMs,
        allowanceReference: this.config.freeCreditReference,
      });
      let snapshotId: number | null = null;
      if (usage) {
        const snapshot = await this.database.query<{ snapshot_id: number }>(
          `insert into app_private.provider_usage_snapshots
           (account_scope, accounting_month, allowance_credits, used_credits, fetched_at, provenance)
           values ($1, $2, $3, $4, $5, $6) returning snapshot_id`,
          [
            usage.scope,
            usage.accountingMonth,
            usage.allowance,
            usage.used,
            usage.fetchedAt,
            usage.provenance,
          ],
        );
        snapshotId = snapshot.rows[0]?.snapshot_id ?? null;
      }
      const nextState =
        decision.state === "queue" ? "reserved" : "deferred_quota";
      if (reconsider) {
        await this.database.query(
          `update app_private.provider_job_runs
           set state = $2, accounting_month = $3, estimate_credits = $4,
               allocation_bucket = $5, usage_snapshot_id = $6,
               decision_reason = $7, decision_at = $8, updated_at = now()
           where job_id = $1 and state = 'deferred_quota'`,
          [
            job.localJobId,
            nextState,
            month,
            estimate,
            bucket,
            snapshotId,
            decision.reason,
            decisionAt,
          ],
        );
      } else {
        await this.database.query(
          `insert into app_private.provider_job_runs
           (job_id, aoi_id, policy_version, graph_version, priority,
            allocation_bucket, accounting_month, state, estimate_credits,
            estimate_provenance, usage_snapshot_id, decision_reason, decision_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'estimated', $10, $11, $12)`,
          [
            job.localJobId,
            job.aoiId,
            job.policyVersion,
            "1.0.0",
            job.priority,
            bucket,
            month,
            nextState,
            estimate,
            snapshotId,
            decision.reason,
            decisionAt,
          ],
        );
      }
      await this.database.query(
        `insert into app_private.dispatch_decisions
         (job_id, policy_version, decision, reason_code, usage_snapshot_id,
          reviewer_id, decided_at) values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          job.localJobId,
          job.policyVersion,
          nextState,
          decision.reason,
          snapshotId,
          release.rows[0]?.reviewer_id ?? null,
          decisionAt,
        ],
      );
      if (decision.state === "deferred_quota") {
        await this.database.query(
          `update app_private.processing_jobs
           set state = 'deferred_quota', deferred_quota_at = $2
           where job_id = $1`,
          [job.localJobId, decisionAt],
        );
        await this.database.query(
          `insert into app_private.coverage_gaps
           (job_id, aoi_id, policy_version, status, starts_at, detail)
           values ($1, $2, $3, 'deferred', $4, $5)
           on conflict (job_id) where job_id is not null
           do update set detail = excluded.detail`,
          [
            job.localJobId,
            job.aoiId,
            job.policyVersion,
            decisionAt,
            decision.reason,
          ],
        );
      } else {
        if (reconsider) {
          await this.database.query(
            `update app_private.processing_jobs
             set state = 'queued', queued_at = $2 where job_id = $1`,
            [job.localJobId, decisionAt],
          );
          await this.database.query(
            `update app_private.coverage_gaps
             set ends_at = greatest($2::timestamptz, starts_at + interval '1 millisecond')
             where job_id = $1 and ends_at is null`,
            [job.localJobId, decisionAt],
          );
        }
        const id = entryId(job.localJobId, "estimate");
        await this.database.query(
          `insert into app_private.credit_ledger
           (ledger_entry_id, event_key, job_id, aoi_id, policy_version,
            priority, accounting_month, allocation_bucket, entry_kind,
            credits, provenance, status)
           values ($1, $1, $2, $3, $4, $5, $6, $7, 'estimate', $8, 'estimated', 'reserved')`,
          [
            id,
            job.localJobId,
            job.aoiId,
            job.policyVersion,
            job.priority,
            month,
            bucket,
            estimate,
          ],
        );
      }
      return decision.state === "queue" ? "reserved" : "deferred_quota";
    });
  }

  async submit(job: PilotJob): Promise<string> {
    if (!this.dispatchEnabled) throw new Error("PART7_DISPATCH_DISABLED");
    const definition = minimalJobDefinition(
      job,
      this.config.collectionId,
      this.config.bands,
    );
    await this.provider.verifyCollection(
      this.config.collectionId,
      this.config.bands,
    );
    const items = await this.provider.verifyStac(
      [job.bbox.west, job.bbox.south, job.bbox.east, job.bbox.north],
      job.from.slice(0, 10),
    );
    if (
      !items.features.some(
        (item) =>
          sceneId("cdse-stac", item.id, item.collection) === job.sceneId &&
          item.polarizations.includes("VV") &&
          item.polarizations.includes("VH"),
      )
    )
      throw new Error("PART7_SCENE_BANDS_UNAVAILABLE");
    const claimed = await this.database.query<{ job_id: string }>(
      `update app_private.provider_job_runs set state = 'submitting', updated_at = now()
       where job_id = $1 and state = 'reserved' returning job_id`,
      [job.localJobId],
    );
    if (!claimed.rows[0]) throw new Error("PART7_SUBMISSION_ALREADY_ATTEMPTED");
    let providerJobId: string | null = null;
    let failureCode: string | null = null;
    try {
      providerJobId = await this.provider.createJob(definition);
    } catch (error) {
      failureCode =
        error instanceof ProviderError ? error.code : "SUBMISSION_AMBIGUOUS";
      await this.database.query(
        `update app_private.provider_job_runs
         set state = 'ambiguous', failure_code = $2, updated_at = now()
         where job_id = $1 and state = 'submitting'`,
        [job.localJobId, failureCode],
      );
    }
    if (failureCode !== null)
      throw new Error(
        failureCode === "PAID_RESOURCE_REQUIRED"
          ? "PART7_PAID_RESOURCE_REQUIRED"
          : "PART7_SUBMISSION_REQUIRES_RECONCILIATION",
      );
    if (providerJobId === null)
      throw new Error("PART7_SUBMISSION_REQUIRES_RECONCILIATION");
    await this.database.query(
      `update app_private.provider_job_runs
       set state = 'submitted', provider_job_id = $2, submitted_at = $3,
           updated_at = now() where job_id = $1 and state = 'submitting'`,
      [job.localJobId, providerJobId, this.now().toISOString()],
    );
    return providerJobId;
  }

  async start(jobId: string, providerJobId: string): Promise<void> {
    if (!this.dispatchEnabled) throw new Error("PART7_DISPATCH_DISABLED");
    const claimed = await this.database.query<{ job_id: string }>(
      `update app_private.provider_job_runs set state = 'queued', updated_at = now()
       where job_id = $1 and provider_job_id = $2 and state = 'submitted'
       returning job_id`,
      [jobId, providerJobId],
    );
    if (!claimed.rows[0]) throw new Error("PART7_START_ALREADY_ATTEMPTED");
    try {
      await this.provider.startJob(providerJobId);
    } catch {
      await this.database.query(
        `update app_private.provider_job_runs
         set failure_code = 'START_UNCERTAIN', updated_at = now()
         where job_id = $1 and provider_job_id = $2 and state = 'queued'`,
        [jobId, providerJobId],
      );
      throw new Error("PART7_START_REQUIRES_RECONCILIATION");
    }
  }

  async observe(jobId: string, providerJobId: string): Promise<void> {
    const raw = await this.provider.jobStatus(providerJobId);
    const status = raw.status;
    if (
      ![
        "created",
        "queued",
        "running",
        "finished",
        "error",
        "canceled",
      ].includes(String(status))
    )
      throw new Error("PART7_INVALID_JOB_STATUS");
    const state = status === "created" ? "submitted" : status;
    const cost = raw.costs;
    if (
      cost !== undefined &&
      (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    )
      throw new Error("PART7_INVALID_COST");
    const providerStarted = raw.started;
    if (
      providerStarted !== undefined &&
      (typeof providerStarted !== "string" ||
        !Number.isFinite(Date.parse(providerStarted)))
    )
      throw new Error("PART7_INVALID_START_TIME");
    const outputBytes =
      state === "finished"
        ? await this.provider.resultSize(providerJobId)
        : null;
    if (
      outputBytes !== null &&
      (!Number.isSafeInteger(outputBytes) || outputBytes < 0)
    )
      throw new Error("PART7_INVALID_OUTPUT_SIZE");
    const timestamp = this.now().toISOString();
    await transaction(this.database, async () => {
      const rows = await this.database.query<{
        state: string;
        estimate_credits: string;
        aoi_id: string;
        policy_version: string;
        priority: string;
        accounting_month: string;
        allocation_bucket: string;
      }>(
        `select state, estimate_credits::text, aoi_id, policy_version,
                priority::text, accounting_month, allocation_bucket
         from app_private.provider_job_runs
         where job_id = $1 and provider_job_id = $2 for update`,
        [jobId, providerJobId],
      );
      const row = rows.rows[0];
      if (!row) throw new Error("PART7_PROVIDER_JOB_UNKNOWN");
      if (["finished", "error", "canceled"].includes(row.state)) return;
      await this.database.query(
        `update app_private.provider_job_runs
         set state = case when $3 = 'submitted' and state in ('queued', 'running')
               then state else $3 end,
             started_at = case when $3 in ('running', 'finished') then coalesce(started_at, $6::timestamptz) else started_at end,
             completed_at = case when $3 in ('finished', 'error', 'canceled') then $4::timestamptz else completed_at end,
             actual_credits = $5, actual_provenance = case when $5::numeric is null then 'unavailable' else 'provider-reported' end,
             output_bytes = coalesce($7::bigint, output_bytes),
             failure_code = case when $3 = 'error' then 'PROVIDER_JOB_FAILED'
               when $3 = 'canceled' then 'PROVIDER_JOB_CANCELLED' else null end,
             updated_at = now()
         where job_id = $1 and provider_job_id = $2`,
        [
          jobId,
          providerJobId,
          state,
          timestamp,
          cost ?? null,
          providerStarted ? new Date(providerStarted).toISOString() : timestamp,
          outputBytes,
        ],
      );
      if (state === "running") {
        await this.database.query(
          `update app_private.processing_jobs
           set state = 'preprocessing', preprocessing_at = coalesce(preprocessing_at, $2)
           where job_id = $1 and state in ('queued', 'preprocessing')`,
          [jobId, timestamp],
        );
      }
      if (!["finished", "error", "canceled"].includes(String(state))) return;
      if (state === "finished") {
        await this.database.query(
          `update app_private.processing_jobs
           set state = 'preprocessing', preprocessing_at = coalesce(preprocessing_at, $2)
           where job_id = $1 and state in ('queued', 'preprocessing')`,
          [jobId, timestamp],
        );
      } else {
        const code =
          state === "error" ? "PROVIDER_JOB_FAILED" : "PROVIDER_JOB_CANCELLED";
        await this.database.query(
          `update app_private.processing_jobs
           set state = 'failed', failed_at = $2,
               failure = jsonb_build_object('code', $3::text, 'stage', 'preprocessing',
                 'retryable', false, 'detail', $3::text)
           where job_id = $1 and state in ('queued', 'preprocessing')`,
          [jobId, timestamp, code],
        );
      }
      if (cost !== undefined) {
        for (const [kind, credits, provenance] of [
          ["actual", cost, "provider-reported"],
          ["adjustment", cost - Number(row.estimate_credits), "derived"],
        ] as const) {
          const id = entryId(jobId, kind);
          await this.database.query(
            `insert into app_private.credit_ledger
             (ledger_entry_id, event_key, job_id, provider_job_id, aoi_id,
              policy_version, priority, accounting_month, allocation_bucket,
              entry_kind, credits, provenance, status)
             values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'recorded')
             on conflict (event_key) do nothing`,
            [
              id,
              jobId,
              providerJobId,
              row.aoi_id,
              row.policy_version,
              row.priority,
              row.accounting_month,
              row.allocation_bucket,
              kind,
              credits,
              provenance,
            ],
          );
        }
      }
      const releaseId = entryId(jobId, "release");
      await this.database.query(
        `insert into app_private.credit_ledger
         (ledger_entry_id, event_key, job_id, provider_job_id, aoi_id,
          policy_version, priority, accounting_month, allocation_bucket,
          entry_kind, credits, provenance, status)
         values ($1, $1, $2, $3, $4, $5, $6, $7, $8,
                 'release', $9, 'derived', 'released')
         on conflict (event_key) do nothing`,
        [
          releaseId,
          jobId,
          providerJobId,
          row.aoi_id,
          row.policy_version,
          row.priority,
          row.accounting_month,
          row.allocation_bucket,
          Number(row.estimate_credits),
        ],
      );
      if (state !== "finished") {
        await this.database.query(
          `insert into app_private.coverage_gaps
           (job_id, aoi_id, policy_version, status, starts_at, detail)
           values ($1, $2, $3, 'failed', $4, $5)
           on conflict (job_id) where job_id is not null
           do update set status = 'failed', starts_at = excluded.starts_at,
                         ends_at = null, detail = excluded.detail`,
          [
            jobId,
            row.aoi_id,
            row.policy_version,
            timestamp,
            String(state).toUpperCase(),
          ],
        );
      }
    });
    if (["finished", "error", "canceled"].includes(String(state)))
      this.usage.invalidate?.();
  }
}
