import {
  authenticateCron,
  DiscoveryService,
  Part8Error,
  readPart8Config,
  type CompletePollInput,
  type DiscoveryDatabase,
  type EnabledAoi,
  type Part8ErrorCode,
  type PersistenceResult,
  type PollWindow,
} from "../../../services/discovery/src/index.ts";

declare const Deno: {
  env: {
    toObject(): Record<string, string>;
    get(name: string): string | undefined;
  };
  serve(handler: (request: Request) => Promise<Response>): void;
};

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

class RestDatabase implements DiscoveryDatabase {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
  ) {}

  private async rpc(name: string, body: Record<string, unknown>) {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("apikey", this.serviceRoleKey);
    headers.set("authorization", ["Bearer", this.serviceRoleKey].join(" "));
    const response = await fetch(`${this.baseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Part8Error("PERSISTENCE_FAILED");
    return (await response.json()) as unknown;
  }

  async enabledAois(at: string): Promise<EnabledAoi[]> {
    const value = await this.rpc("part8_enabled_aoi_queries", { p_at: at });
    if (!Array.isArray(value)) throw new Part8Error("PERSISTENCE_FAILED");
    return value.map((row) => {
      if (typeof row !== "object" || row === null || Array.isArray(row))
        throw new Part8Error("PERSISTENCE_FAILED");
      const source = row as Record<string, unknown>;
      if (
        typeof source.aoi_id !== "string" ||
        typeof source.policy_version !== "string" ||
        typeof source.geometry !== "object" ||
        source.geometry === null ||
        Array.isArray(source.geometry)
      )
        throw new Part8Error("PERSISTENCE_FAILED");
      return {
        aoiId: source.aoi_id,
        policyVersion: source.policy_version,
        geometry: source.geometry as Record<string, unknown>,
      };
    });
  }

  async complete(input: CompletePollInput): Promise<PersistenceResult> {
    const value = await this.rpc(
      "record_part8_discovery_poll",
      pollArguments(input.window, input.metrics.durationMs, {
        p_status: "succeeded",
        p_provider_request_id: input.metrics.providerRequestId,
        p_pages_fetched: input.metrics.pagesFetched,
        p_raw_item_count: input.metrics.rawItemCount,
        p_unique_item_count: input.metrics.uniqueItemCount,
        p_normalized_item_count: input.metrics.normalizedItemCount,
        p_rejected_item_count: input.metrics.rejectedItemCount,
        p_missing_vh_count: input.metrics.missingVhCount,
        p_warnings: input.metrics.warnings,
        p_scenes: input.scenes,
        p_preprocessing_version: input.preprocessingVersion,
        p_model_version: input.modelVersion,
      }),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new Part8Error("PERSISTENCE_FAILED");
    const result = value as Record<string, unknown>;
    for (const key of [
      "pollRunId",
      "createdSceneCount",
      "updatedSceneCount",
      "createdJobCount",
      "existingJobCount",
    ]) {
      if (typeof result[key] !== "number")
        throw new Part8Error("PERSISTENCE_FAILED");
    }
    return result as unknown as PersistenceResult;
  }

  async fail(input: {
    window: PollWindow;
    code: Part8ErrorCode;
    durationMs: number;
  }): Promise<number | null> {
    const value = await this.rpc(
      "record_part8_discovery_poll",
      pollArguments(input.window, input.durationMs, {
        p_status: "failed",
        p_error_code: input.code,
      }),
    );
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const pollRunId = (value as Record<string, unknown>).pollRunId;
    return typeof pollRunId === "number" ? pollRunId : null;
  }
}

const pollArguments = (
  window: PollWindow,
  durationMs: number,
  extra: Record<string, unknown>,
) => ({
  p_poll_started_at: window.startedAt,
  p_window_from: window.from,
  p_window_to: window.to,
  p_duration_ms: durationMs,
  ...extra,
});

export async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST")
    return jsonResponse(405, { error: "METHOD_NOT_ALLOWED" });
  const environment = Deno.env.toObject();
  const cronSecret = environment.PART8_CRON_SECRET ?? "";
  if (
    !(await authenticateCron(
      request.headers.get("x-discovery-secret"),
      cronSecret,
    ))
  )
    return jsonResponse(401, { error: "UNAUTHORIZED" });
  const baseUrl = environment.SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRoleKey)
    return jsonResponse(503, { error: "INVALID_CONFIG" });
  try {
    const service = new DiscoveryService({
      database: new RestDatabase(baseUrl.replace(/\/$/u, ""), serviceRoleKey),
      config: readPart8Config(environment),
    });
    const result = await service.poll();
    return jsonResponse(200, {
      pollRunId: result.pollRunId,
      pagesFetched: result.pagesFetched,
      uniqueItemCount: result.uniqueItemCount,
      normalizedItemCount: result.normalizedItemCount,
      rejectedItemCount: result.rejectedItemCount,
      missingVhCount: result.missingVhCount,
      createdSceneCount: result.createdSceneCount,
      updatedSceneCount: result.updatedSceneCount,
      createdJobCount: result.createdJobCount,
      existingJobCount: result.existingJobCount,
    });
  } catch (error) {
    const code =
      error instanceof Part8Error ? error.code : "PERSISTENCE_FAILED";
    const status = code === "INVALID_CONFIG" ? 503 : 502;
    return jsonResponse(status, { error: code });
  }
}

Deno.serve(handler);
