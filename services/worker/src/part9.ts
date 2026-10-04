import { createHash } from "node:crypto";

export type JobState =
  | "discovered"
  | "queued"
  | "preprocessing"
  | "inferencing"
  | "ready_for_review"
  | "failed"
  | "deferred_quota";

export type StageName = "preprocessing" | "inferencing" | "asset_upload";

export type Part9ErrorCode =
  | "NETWORK_TIMEOUT"
  | "TEMPORARY_PROVIDER_FAILURE"
  | "GITHUB_TRANSIENT_FAILURE"
  | "TEMPORARY_STORAGE_FAILURE"
  | "WORKER_INTERRUPTED"
  | "PROVIDER_STATUS_UNAVAILABLE"
  | "UNSUPPORTED_POLARIZATION"
  | "INVALID_GEOMETRY"
  | "CONTRACT_VALIDATION_FAILED"
  | "CORRUPTED_OUTPUT"
  | "INVALID_CONFIGURATION"
  | "INTERNAL_ERROR";

const retryableCodes = new Set<Part9ErrorCode>([
  "NETWORK_TIMEOUT",
  "TEMPORARY_PROVIDER_FAILURE",
  "GITHUB_TRANSIENT_FAILURE",
  "TEMPORARY_STORAGE_FAILURE",
  "WORKER_INTERRUPTED",
  "PROVIDER_STATUS_UNAVAILABLE",
]);

export class Part9Error extends Error {
  override name = "Part9Error";
  readonly retryable: boolean;

  constructor(
    readonly code: Part9ErrorCode,
    detail: string = code,
  ) {
    super(sanitizeErrorDetail(detail));
    this.retryable = retryableCodes.has(code);
  }
}

export const sanitizeErrorDetail = (detail: string): string => {
  const normalized = detail.replace(/[\r\n\t]+/gu, " ").trim();
  if (
    normalized.length === 0 ||
    normalized.length > 500 ||
    /(token|secret|password|authorization|cookie|signed[ _-]?url|coordinates?)/iu.test(
      normalized,
    )
  )
    return "SANITIZED_ERROR_DETAIL";
  return normalized;
};

export const classifyError = (error: unknown): Part9Error =>
  error instanceof Part9Error
    ? error
    : new Part9Error("INTERNAL_ERROR", "UNCLASSIFIED_WORKER_FAILURE");

export interface Part9Config {
  workerId: string;
  leaseSeconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  stageVersion: string;
}

const boundedInteger = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = environment[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Part9Error("INVALID_CONFIGURATION", name);
  return value;
};

export const readPart9Config = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Part9Config => {
  const workerId = environment.PART9_WORKER_ID ?? "worker:local";
  const stageVersion = environment.PART9_STAGE_VERSION ?? "1.0.0";
  if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/u.test(workerId))
    throw new Part9Error("INVALID_CONFIGURATION", "PART9_WORKER_ID");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(stageVersion))
    throw new Part9Error("INVALID_CONFIGURATION", "PART9_STAGE_VERSION");
  const retryBaseSeconds = boundedInteger(
    environment,
    "PART9_RETRY_BASE_SECONDS",
    30,
    1,
    600,
  );
  const retryMaxSeconds = boundedInteger(
    environment,
    "PART9_RETRY_MAX_SECONDS",
    1800,
    retryBaseSeconds,
    3600,
  );
  return {
    workerId,
    stageVersion,
    leaseSeconds: boundedInteger(
      environment,
      "PART9_LEASE_SECONDS",
      300,
      60,
      3600,
    ),
    retryBaseSeconds,
    retryMaxSeconds,
  };
};

export const retryDelaySeconds = (
  attempt: number,
  base: number,
  maximum: number,
  random: () => number,
): number => {
  if (
    !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Number.isFinite(base) ||
    base < 1 ||
    maximum < base
  )
    throw new Part9Error("INVALID_CONFIGURATION");
  const capped = Math.min(maximum, base * 2 ** Math.min(attempt - 1, 20));
  const jitter = Math.max(0, Math.min(0.999_999, random()));
  return Math.max(
    1,
    Math.min(maximum, Math.round(capped * (0.5 + jitter / 2))),
  );
};

export interface ClaimedJob {
  jobId: string;
  state: "preprocessing";
  attemptCount: number;
  maxAttempts: number;
  claimToken: string;
  leaseExpiresAt: string;
  providerJobId: string | null;
}

export interface StageOutput {
  bytes: Uint8Array;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface Part9Queue {
  claim(
    workerId: string,
    leaseSeconds: number,
    now: Date,
  ): Promise<ClaimedJob | null>;
  renew(
    jobId: string,
    claimToken: string,
    leaseSeconds: number,
    now: Date,
  ): Promise<boolean>;
  checkpoint(
    jobId: string,
    claimToken: string,
    stage: StageName,
    stageVersion: string,
    checksum: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
    now: Date,
  ): Promise<{ reused: boolean }>;
  advance(
    jobId: string,
    claimToken: string,
    target: "inferencing" | "ready_for_review",
    now: Date,
  ): Promise<boolean>;
  fail(
    jobId: string,
    claimToken: string,
    error: Part9Error,
    retryDelaySeconds: number,
    now: Date,
  ): Promise<"queued" | "failed">;
}

export interface SyntheticHandlers {
  preprocessing(job: ClaimedJob): Promise<StageOutput>;
  inferencing(job: ClaimedJob): Promise<StageOutput>;
}

const checksum = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export class Part9Worker {
  constructor(
    private readonly queue: Part9Queue,
    private readonly handlers: SyntheticHandlers,
    private readonly config = readPart9Config(),
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  async runOne(): Promise<"empty" | "completed" | "queued" | "failed"> {
    const job = await this.queue.claim(
      this.config.workerId,
      this.config.leaseSeconds,
      this.now(),
    );
    if (!job) return "empty";
    try {
      if (
        !(await this.queue.renew(
          job.jobId,
          job.claimToken,
          this.config.leaseSeconds,
          this.now(),
        ))
      )
        throw new Part9Error("WORKER_INTERRUPTED", "STALE_JOB_CLAIM");
      const preprocessing = await this.handlers.preprocessing(job);
      await this.queue.checkpoint(
        job.jobId,
        job.claimToken,
        "preprocessing",
        this.config.stageVersion,
        checksum(preprocessing.bytes),
        preprocessing.metadata ?? {},
        this.now(),
      );
      if (
        !(await this.queue.advance(
          job.jobId,
          job.claimToken,
          "inferencing",
          this.now(),
        ))
      )
        throw new Part9Error("WORKER_INTERRUPTED", "STALE_JOB_CLAIM");
      if (
        !(await this.queue.renew(
          job.jobId,
          job.claimToken,
          this.config.leaseSeconds,
          this.now(),
        ))
      )
        throw new Part9Error("WORKER_INTERRUPTED", "STALE_JOB_CLAIM");
      const inferencing = await this.handlers.inferencing(job);
      await this.queue.checkpoint(
        job.jobId,
        job.claimToken,
        "inferencing",
        this.config.stageVersion,
        checksum(inferencing.bytes),
        inferencing.metadata ?? {},
        this.now(),
      );
      if (
        !(await this.queue.advance(
          job.jobId,
          job.claimToken,
          "ready_for_review",
          this.now(),
        ))
      )
        throw new Part9Error("WORKER_INTERRUPTED", "STALE_JOB_CLAIM");
      return "completed";
    } catch (error) {
      const classified = classifyError(error);
      return this.queue.fail(
        job.jobId,
        job.claimToken,
        classified,
        retryDelaySeconds(
          job.attemptCount,
          this.config.retryBaseSeconds,
          this.config.retryMaxSeconds,
          this.random,
        ),
        this.now(),
      );
    }
  }
}

export type ProviderRecoveryStatus =
  | "not_submitted"
  | "queued"
  | "running"
  | "finished"
  | "error"
  | "canceled"
  | "unavailable"
  | "ambiguous";

export interface ExpiredLease {
  jobId: string;
  claimToken: string;
  attemptCount: number;
  providerJobId: string | null;
}

export interface RecoveryQueue {
  expired(now: Date): Promise<ExpiredLease[]>;
  recover(
    lease: ExpiredLease,
    status: ProviderRecoveryStatus,
    retryDelaySeconds: number,
    now: Date,
  ): Promise<JobState>;
}

export interface ProviderStatusReader {
  status(
    providerJobId: string,
  ): Promise<Exclude<ProviderRecoveryStatus, "not_submitted">>;
}

export class Part9Recovery {
  constructor(
    private readonly queue: RecoveryQueue,
    private readonly provider: ProviderStatusReader,
    private readonly config = readPart9Config(),
    private readonly now: () => Date = () => new Date(),
    private readonly random: () => number = Math.random,
  ) {}

  async run(): Promise<Array<{ jobId: string; state: JobState }>> {
    const now = this.now();
    const recovered: Array<{ jobId: string; state: JobState }> = [];
    for (const lease of await this.queue.expired(now)) {
      let status: ProviderRecoveryStatus = "not_submitted";
      if (lease.providerJobId !== null) {
        try {
          status = await this.provider.status(lease.providerJobId);
        } catch {
          status = "unavailable";
        }
      }
      const state = await this.queue.recover(
        lease,
        status,
        retryDelaySeconds(
          lease.attemptCount,
          this.config.retryBaseSeconds,
          this.config.retryMaxSeconds,
          this.random,
        ),
        now,
      );
      recovered.push({ jobId: lease.jobId, state });
    }
    return recovered;
  }
}
