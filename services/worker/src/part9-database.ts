import type {
  ClaimedJob,
  ExpiredLease,
  JobState,
  Part9Error,
  Part9Queue,
  ProviderRecoveryStatus,
  RecoveryQueue,
  StageName,
} from "./part9.js";
import type { SqlClient } from "./part7-dispatch.js";

export class Part9Database implements Part9Queue, RecoveryQueue {
  constructor(private readonly client: SqlClient) {}

  async claim(workerId: string, leaseSeconds: number, now: Date) {
    const result = await this.client.query<{
      job_id: string;
      state: "preprocessing";
      attempt_count: number;
      max_attempts: number;
      claim_token: string;
      lease_expires_at: Date;
      provider_job_id: string | null;
    }>("select * from app_private.claim_processing_job($1, $2, $3)", [
      workerId,
      leaseSeconds,
      now.toISOString(),
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      jobId: row.job_id,
      state: row.state,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      claimToken: row.claim_token,
      leaseExpiresAt: row.lease_expires_at.toISOString(),
      providerJobId: row.provider_job_id,
    } satisfies ClaimedJob;
  }

  async renew(jobId: string, token: string, seconds: number, now: Date) {
    const result = await this.client.query<{ renewed: boolean }>(
      "select app_private.renew_processing_job_lease($1, $2, $3, $4) as renewed",
      [jobId, token, seconds, now.toISOString()],
    );
    return result.rows[0]?.renewed === true;
  }

  async checkpoint(
    jobId: string,
    token: string,
    stage: StageName,
    version: string,
    checksum: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
    now: Date,
  ) {
    const existing = await this.client.query(
      `select 1 from app_private.processing_stage_checkpoints
       where job_id = $1 and stage_name = $2 and stage_version = $3`,
      [jobId, stage, version],
    );
    await this.client.query(
      "select app_private.complete_processing_stage($1, $2, $3, $4, $5, $6, $7)",
      [
        jobId,
        token,
        stage,
        version,
        checksum,
        JSON.stringify(metadata),
        now.toISOString(),
      ],
    );
    return { reused: existing.rows.length === 1 };
  }

  async advance(
    jobId: string,
    token: string,
    target: "inferencing" | "ready_for_review",
    now: Date,
  ) {
    const result = await this.client.query<{ advanced: boolean }>(
      "select app_private.advance_processing_job($1, $2, $3, $4) as advanced",
      [jobId, token, target, now.toISOString()],
    );
    return result.rows[0]?.advanced === true;
  }

  async fail(
    jobId: string,
    token: string,
    error: Part9Error,
    delay: number,
    now: Date,
  ) {
    const result = await this.client.query<{ state: "queued" | "failed" }>(
      "select app_private.fail_processing_job($1, $2, $3, $4, $5, $6, $7)::text as state",
      [
        jobId,
        token,
        error.code,
        error.message,
        error.retryable,
        delay,
        now.toISOString(),
      ],
    );
    const state = result.rows[0]?.state;
    if (!state) throw new Error("PART9_FAILURE_NOT_RECORDED");
    return state;
  }

  async expired(now: Date): Promise<ExpiredLease[]> {
    const result = await this.client.query<{
      job_id: string;
      claim_token: string;
      attempt_count: number;
      provider_job_id: string | null;
    }>(
      `select job_id, claim_token::text, attempt_count, provider_job_id
       from app_private.processing_jobs
       where state in ('preprocessing', 'inferencing')
         and lease_expires_at <= $1
       order by lease_expires_at, job_id`,
      [now.toISOString()],
    );
    return result.rows.map((row) => ({
      jobId: row.job_id,
      claimToken: row.claim_token,
      attemptCount: row.attempt_count,
      providerJobId: row.provider_job_id,
    }));
  }

  async recover(
    lease: ExpiredLease,
    status: ProviderRecoveryStatus,
    delay: number,
    now: Date,
  ): Promise<JobState> {
    const result = await this.client.query<{ state: JobState }>(
      "select app_private.recover_expired_processing_job($1, $2, $3, $4, $5)::text as state",
      [lease.jobId, lease.claimToken, status, delay, now.toISOString()],
    );
    const state = result.rows[0]?.state;
    if (!state) throw new Error("PART9_RECOVERY_NOT_RECORDED");
    return state;
  }
}
