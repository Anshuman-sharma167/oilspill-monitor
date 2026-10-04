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

export interface Part9BrokerConfiguration {
  job_id: string;
  broker_url: string;
  job_token: string;
}

const jobIdPattern = /^job:[0-9a-f]{32}$/u;

export const validatePart9BrokerConfiguration = (
  value: unknown,
  expectedJobId: string,
): Part9BrokerConfiguration => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_PART9_BROKER_CONFIGURATION");
  const configuration = value as Record<string, unknown>;
  if (
    !jobIdPattern.test(expectedJobId) ||
    configuration.job_id !== expectedJobId ||
    typeof configuration.broker_url !== "string" ||
    typeof configuration.job_token !== "string" ||
    configuration.job_token.length < 32
  )
    throw new Error("INVALID_PART9_BROKER_CONFIGURATION");
  const url = new URL(configuration.broker_url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("INVALID_PART9_BROKER_CONFIGURATION");
  return {
    job_id: expectedJobId,
    broker_url: url.toString().replace(/\/$/u, ""),
    job_token: configuration.job_token,
  };
};

export class Part9BrokerDatabase implements Part9Queue, RecoveryQueue {
  constructor(
    private readonly configuration: Part9BrokerConfiguration,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request<T>(
    body: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const response = await this.fetcher(
      `${this.configuration.broker_url}/database`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.configuration.job_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...body, job_id: this.configuration.job_id }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok)
      throw new Error(`PART9_BROKER_REQUEST_FAILED_${response.status}`);
    return (await response.json()) as T;
  }

  async claim(workerId: string, leaseSeconds: number, now: Date) {
    const result = await this.request<{ row: ClaimedJob | null }>({
      operation: "claim",
      worker_id: workerId,
      lease_seconds: leaseSeconds,
      now: now.toISOString(),
    });
    return result.row;
  }

  async renew(jobId: string, token: string, seconds: number, now: Date) {
    this.assertJob(jobId);
    const result = await this.request<{ renewed: boolean }>({
      operation: "renew",
      claim_token: token,
      lease_seconds: seconds,
      now: now.toISOString(),
    });
    return result.renewed === true;
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
    this.assertJob(jobId);
    return this.request<{ reused: boolean }>({
      operation: "checkpoint",
      claim_token: token,
      stage,
      stage_version: version,
      checksum,
      metadata,
      now: now.toISOString(),
    });
  }

  async advance(
    jobId: string,
    token: string,
    target: "inferencing" | "ready_for_review",
    now: Date,
  ) {
    this.assertJob(jobId);
    const result = await this.request<{ advanced: boolean }>({
      operation: "advance",
      claim_token: token,
      target,
      now: now.toISOString(),
    });
    return result.advanced === true;
  }

  async fail(
    jobId: string,
    token: string,
    error: Part9Error,
    delay: number,
    now: Date,
  ) {
    this.assertJob(jobId);
    const result = await this.request<{
      state: "queued" | "failed" | null;
    }>({
      operation: "fail",
      claim_token: token,
      error_code: error.code,
      error_detail: error.message,
      retryable: error.retryable,
      retry_delay_seconds: delay,
      now: now.toISOString(),
    });
    if (result.state !== "queued" && result.state !== "failed")
      throw new Error("PART9_FAILURE_NOT_RECORDED");
    return result.state;
  }

  async expired(now: Date): Promise<ExpiredLease[]> {
    const result = await this.request<{ rows: ExpiredLease[] }>({
      operation: "expired",
      now: now.toISOString(),
    });
    return result.rows;
  }

  async recover(
    lease: ExpiredLease,
    status: ProviderRecoveryStatus,
    delay: number,
    now: Date,
  ): Promise<JobState> {
    this.assertJob(lease.jobId);
    const result = await this.request<{ state: JobState | null }>({
      operation: "recover",
      claim_token: lease.claimToken,
      status,
      retry_delay_seconds: delay,
      now: now.toISOString(),
    });
    if (!result.state) throw new Error("PART9_RECOVERY_NOT_RECORDED");
    return result.state;
  }

  private assertJob(jobId: string): void {
    if (jobId !== this.configuration.job_id)
      throw new Error("PART9_JOB_SCOPE_MISMATCH");
  }
}
