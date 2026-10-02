import {
  Part8Error,
  type CompletePollInput,
  type DiscoveryDatabase,
  type EnabledAoi,
  type Part8ErrorCode,
  type PersistenceResult,
  type PollWindow,
} from "./index.js";

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export class SqlDiscoveryDatabase implements DiscoveryDatabase {
  constructor(private readonly client: SqlClient) {}

  async enabledAois(at: string): Promise<EnabledAoi[]> {
    const result = await this.client.query<{
      aoi_id: string;
      policy_version: string;
      geometry: Record<string, unknown>;
    }>("select * from public.part8_enabled_aoi_queries($1::timestamptz)", [at]);
    return result.rows.map((row) => ({
      aoiId: row.aoi_id,
      policyVersion: row.policy_version,
      geometry: row.geometry,
    }));
  }

  async complete(input: CompletePollInput): Promise<PersistenceResult> {
    return this.record(input.window, input.metrics.durationMs, {
      status: "succeeded",
      errorCode: null,
      requestId: input.metrics.providerRequestId,
      pages: input.metrics.pagesFetched,
      raw: input.metrics.rawItemCount,
      unique: input.metrics.uniqueItemCount,
      normalized: input.metrics.normalizedItemCount,
      rejected: input.metrics.rejectedItemCount,
      missingVh: input.metrics.missingVhCount,
      warnings: input.metrics.warnings,
      scenes: input.scenes,
      preprocessingVersion: input.preprocessingVersion,
      modelVersion: input.modelVersion,
    });
  }

  async fail(input: {
    window: PollWindow;
    code: Part8ErrorCode;
    durationMs: number;
  }): Promise<number | null> {
    const result = await this.record(input.window, input.durationMs, {
      status: "failed",
      errorCode: input.code,
      requestId: null,
      pages: 0,
      raw: 0,
      unique: 0,
      normalized: 0,
      rejected: 0,
      missingVh: 0,
      warnings: [],
      scenes: [],
      preprocessingVersion: "1.0.0",
      modelVersion: "1.0.0",
    });
    return result.pollRunId;
  }

  private async record(
    window: PollWindow,
    durationMs: number,
    input: {
      status: "succeeded" | "failed";
      errorCode: Part8ErrorCode | null;
      requestId: string | null;
      pages: number;
      raw: number;
      unique: number;
      normalized: number;
      rejected: number;
      missingVh: number;
      warnings: string[];
      scenes: unknown[];
      preprocessingVersion: string;
      modelVersion: string;
    },
  ): Promise<PersistenceResult> {
    try {
      const result = await this.client.query<{ result: PersistenceResult }>(
        `select public.record_part8_discovery_poll(
          $1, $2::timestamptz, $3::timestamptz, $4::timestamptz, $5,
          $6, $7, $8, $9, $10, $11, $12, $13,
          $14::jsonb, $15::jsonb, $16, $17
        ) as result`,
        [
          input.status,
          window.startedAt,
          window.from,
          window.to,
          durationMs,
          input.errorCode,
          input.requestId,
          input.pages,
          input.raw,
          input.unique,
          input.normalized,
          input.rejected,
          input.missingVh,
          JSON.stringify(input.warnings),
          JSON.stringify(input.scenes),
          input.preprocessingVersion,
          input.modelVersion,
        ],
      );
      const persisted = result.rows[0]?.result;
      if (persisted === undefined)
        throw new Error("missing persistence result");
      return persisted;
    } catch (error) {
      throw new Part8Error("PERSISTENCE_FAILED", null, { cause: error });
    }
  }
}
