import { createHash } from "node:crypto";

import { requireServerConfig } from "../../../packages/config/src/server.js";
import { processingJobId } from "../../../packages/schemas/src/identity.js";

export const PART7_GRAPH_VERSION = "1.0.0";
export const STAC_URL = "https://stac.dataspace.copernicus.eu/v1/search";
export const OPENEO_URL = "https://openeo.dataspace.copernicus.eu/openeo/1.2";
const TOKEN_URL =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";

export class Part7ConfigError extends Error {
  override name = "Part7ConfigError";
}

export function readPart7Config(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number => {
    const value = environment[name];
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      throw new Part7ConfigError(`Invalid ${name}`);
    return parsed;
  };
  const collectionId = environment.CDSE_COLLECTION_ID || "SENTINEL1_GRD";
  const vvBand = environment.CDSE_VV_BAND || "VV";
  const vhBand = environment.CDSE_VH_BAND || "VH";
  if (
    !/^[A-Z0-9_]+$/u.test(collectionId) ||
    !/^[A-Z0-9_]+$/u.test(vvBand) ||
    !/^[A-Z0-9_]+$/u.test(vhBand) ||
    vvBand === vhBand
  )
    throw new Part7ConfigError("Invalid CDSE collection or band name");
  const dispatch = environment.CDSE_DISPATCH_ENABLED ?? "false";
  if (dispatch !== "true" && dispatch !== "false")
    throw new Part7ConfigError("Invalid CDSE_DISPATCH_ENABLED");
  return {
    collectionId,
    bands: [vvBand, vhBand] as const,
    tokenSafetyMs: integer("CDSE_TOKEN_SAFETY_MS", 30_000, 0, 300_000),
    usageCacheMs: integer("CDSE_USAGE_CACHE_MS", 300_000, 1_000, 900_000),
    freeCreditReference: integer(
      "CDSE_FREE_CREDIT_REFERENCE",
      10_000,
      1,
      1_000_000,
    ),
    dispatchEnabled: dispatch === "true",
  };
}

export type ProviderErrorCode =
  | "AUTH_REJECTED"
  | "AUTH_LOCKED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "INVALID_PROVIDER_RESPONSE"
  | "PAID_RESOURCE_REQUIRED"
  | "SUBMISSION_AMBIGUOUS";

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    readonly code: ProviderErrorCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
  }
}

type Fetch = typeof fetch;
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  return value as Record<string, unknown>;
};

const nonnegative = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  return value;
};

const retryAfter = (header: string | null, now: number): number | null => {
  if (header === null) return null;
  const seconds = Number(header);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(header) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 300_000) : null;
};

async function request(
  fetcher: Fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  now: () => number,
): Promise<Response> {
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429)
      throw new ProviderError(
        "RATE_LIMITED",
        retryAfter(response.headers.get("retry-after"), now()),
      );
    if (response.status === 402)
      throw new ProviderError("PAID_RESOURCE_REQUIRED");
    if (response.status === 423) throw new ProviderError("AUTH_LOCKED");
    if (response.status === 401 || response.status === 403)
      throw new ProviderError("AUTH_REJECTED");
    if (response.status >= 500) throw new ProviderError("PROVIDER_UNAVAILABLE");
    if (!response.ok) throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    return response;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof Error && error.name === "TimeoutError")
      throw new ProviderError("PROVIDER_TIMEOUT");
    throw new ProviderError("PROVIDER_UNAVAILABLE");
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return record(await response.json());
  } catch {
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  }
}

export class CdseAuth {
  private cached: { value: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly safetyMs = 30_000,
    private readonly timeoutMs = 10_000,
  ) {
    if (!clientId || !clientSecret || safetyMs < 0 || timeoutMs <= 0)
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  }

  static fromEnvironment(environment = process.env): CdseAuth {
    const config = requireServerConfig(
      ["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET"],
      environment,
    );
    return new CdseAuth(
      config.CDSE_CLIENT_ID,
      config.CDSE_CLIENT_SECRET,
      fetch,
      Date.now,
      readPart7Config(environment).tokenSafetyMs,
    );
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - this.safetyMs > this.now())
      return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.acquire().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async acquire(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: "openid email",
    });
    const response = await request(
      this.fetcher,
      TOKEN_URL,
      { method: "POST", body },
      this.timeoutMs,
      this.now,
    );
    const payload = await json(response);
    const value = payload.access_token;
    const lifetime = payload.expires_in;
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      typeof lifetime !== "number" ||
      !Number.isFinite(lifetime) ||
      lifetime <= 0
    )
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    this.cached = { value, expiresAt: this.now() + lifetime * 1000 };
    return value;
  }
}

export interface StacItem {
  id: string;
  collection: string;
  datetime: string;
  polarizations: string[];
}

export function sanitizeStac(value: unknown): {
  fixture_version: "1.0.0";
  sanitized: true;
  type: "FeatureCollection";
  features: StacItem[];
} {
  const root = record(value);
  if (
    root.type !== "FeatureCollection" ||
    !Array.isArray(root.features) ||
    root.features.length === 0
  )
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  const features = root.features.map((item) => {
    const feature = record(item);
    const properties = record(feature.properties);
    if (
      feature.type !== "Feature" ||
      typeof feature.id !== "string" ||
      !/^[A-Za-z0-9_:-]+$/u.test(feature.id) ||
      feature.collection !== "sentinel-1-grd" ||
      typeof properties.datetime !== "string" ||
      !Number.isFinite(Date.parse(properties.datetime)) ||
      !Array.isArray(properties["sar:polarizations"])
    )
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    const polarizations = properties["sar:polarizations"];
    if (!polarizations.every((band) => typeof band === "string"))
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    return {
      id: feature.id,
      collection: feature.collection,
      datetime: new Date(properties.datetime).toISOString(),
      polarizations: polarizations as string[],
    };
  });
  return {
    fixture_version: "1.0.0",
    sanitized: true,
    type: "FeatureCollection",
    features,
  };
}

export function validateSanitizedStac(value: unknown): void {
  const root = record(value);
  if (
    root.fixture_version !== "1.0.0" ||
    root.sanitized !== true ||
    root.type !== "FeatureCollection" ||
    !Array.isArray(root.features) ||
    root.features.length === 0 ||
    Object.keys(root).length !== 4
  )
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  for (const item of root.features) {
    const feature = record(item);
    if (
      Object.keys(feature).sort().join(",") !==
        "collection,datetime,id,polarizations" ||
      typeof feature.id !== "string" ||
      !/^[A-Za-z0-9_:-]+$/u.test(feature.id) ||
      feature.collection !== "sentinel-1-grd" ||
      typeof feature.datetime !== "string" ||
      !Number.isFinite(Date.parse(feature.datetime)) ||
      new Date(feature.datetime).toISOString() !== feature.datetime ||
      !Array.isArray(feature.polarizations) ||
      !feature.polarizations.includes("VV") ||
      !feature.polarizations.includes("VH")
    )
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  }
}

export function validateCollection(
  value: unknown,
  collectionId = "SENTINEL1_GRD",
  bands: readonly string[] = ["VV", "VH"],
): void {
  const metadata = record(value);
  if (
    metadata.id !== collectionId ||
    !/SENTINEL.?1.*GRD/iu.test(String(metadata.title ?? metadata.id))
  )
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  const dimensions = record(metadata["cube:dimensions"]);
  const bandDimension = record(dimensions.bands);
  if (!Array.isArray(bandDimension.values))
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  for (const band of bands) {
    if (!bandDimension.values.includes(band))
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  }
}

export interface PilotJob {
  localJobId: string;
  aoiId: string;
  policyVersion: string;
  priority: "P0" | "P1" | "P2";
  sceneId: string;
  bbox: { west: number; south: number; east: number; north: number };
  from: string;
  to: string;
}

export function minimalJobDefinition(
  job: PilotJob,
  collectionId = "SENTINEL1_GRD",
  bands: readonly string[] = ["VV", "VH"],
): Record<string, unknown> {
  const { west, south, east, north } = job.bbox;
  if (
    job.localJobId !==
      processingJobId(job.sceneId, job.aoiId, PART7_GRAPH_VERSION, "1.0.0") ||
    ![west, south, east, north].every(Number.isFinite) ||
    west < 69 ||
    east > 73 ||
    south < 18 ||
    north > 21 ||
    east <= west ||
    north <= south ||
    (east - west) * (north - south) > 0.0001 ||
    !Number.isFinite(Date.parse(job.from)) ||
    !Number.isFinite(Date.parse(job.to)) ||
    Date.parse(job.to) <= Date.parse(job.from) ||
    Date.parse(job.to) - Date.parse(job.from) > 86_400_000 ||
    bands.length !== 2 ||
    bands[0] === bands[1] ||
    !bands.every((band) => /^[A-Z0-9_]+$/u.test(band))
  )
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  return {
    title: `oilspill-part7-${createHash("sha256").update(job.localJobId).digest("hex").slice(0, 20)}`,
    description: `graph ${PART7_GRAPH_VERSION}; AOI ${job.aoiId}; policy ${job.policyVersion}`,
    process: {
      process_graph: {
        load: {
          process_id: "load_collection",
          arguments: {
            id: collectionId,
            spatial_extent: { west, south, east, north, crs: "EPSG:4326" },
            temporal_extent: [job.from, job.to],
            bands,
          },
        },
        save: {
          process_id: "save_result",
          arguments: { data: { from_node: "load" }, format: "GTiff" },
          result: true,
        },
      },
    },
  };
}

export class CdseProvider {
  constructor(
    private readonly auth: CdseAuth,
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = 10_000,
  ) {}

  private async openEo(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const token = await this.auth.token();
    return request(
      this.fetcher,
      `${OPENEO_URL}${path}`,
      {
        ...init,
        headers: {
          authorization: `Bearer oidc/CDSE/${token}`,
          "content-type": "application/json",
        },
      },
      this.timeoutMs,
      this.now,
    );
  }

  async verifyStac(bbox: [number, number, number, number], date: string) {
    if (
      bbox.length !== 4 ||
      !bbox.every(Number.isFinite) ||
      bbox[0] < 69 ||
      bbox[2] > 73 ||
      bbox[1] < 18 ||
      bbox[3] > 21 ||
      bbox[2] <= bbox[0] ||
      bbox[3] <= bbox[1] ||
      (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > 0.0001 ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(date)
    )
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    const response = await request(
      this.fetcher,
      STAC_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          collections: ["sentinel-1-grd"],
          bbox,
          datetime: `${date}T00:00:00Z/${date}T23:59:59Z`,
          limit: 2,
        }),
      },
      this.timeoutMs,
      this.now,
    );
    return sanitizeStac(await json(response));
  }

  async verifyCollection(
    collectionId = "SENTINEL1_GRD",
    bands: readonly string[] = ["VV", "VH"],
  ) {
    if (!/^[A-Z0-9_]+$/u.test(collectionId))
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    const metadata = await json(
      await this.openEo(`/collections/${collectionId}`),
    );
    validateCollection(metadata, collectionId, bands);
    return metadata;
  }

  async account(): Promise<Record<string, unknown>> {
    return json(await this.openEo("/me"));
  }

  async createJob(definition: Record<string, unknown>): Promise<string> {
    let response: Response;
    try {
      response = await this.openEo("/jobs", {
        method: "POST",
        body: JSON.stringify(definition),
      });
    } catch (error) {
      if (
        error instanceof ProviderError &&
        [
          "PAID_RESOURCE_REQUIRED",
          "AUTH_REJECTED",
          "AUTH_LOCKED",
          "RATE_LIMITED",
        ].includes(error.code)
      )
        throw error;
      throw new ProviderError("SUBMISSION_AMBIGUOUS");
    }
    const location = response.headers.get("location");
    const id = location?.match(/\/jobs\/([a-zA-Z0-9-]+)$/u)?.[1];
    if (!id) throw new ProviderError("SUBMISSION_AMBIGUOUS");
    return id;
  }

  async startJob(providerJobId: string): Promise<void> {
    if (!/^[a-zA-Z0-9-]+$/u.test(providerJobId))
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    await this.openEo(`/jobs/${providerJobId}/results`, { method: "POST" });
  }

  async jobStatus(providerJobId: string): Promise<Record<string, unknown>> {
    if (!/^[a-zA-Z0-9-]+$/u.test(providerJobId))
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    return json(await this.openEo(`/jobs/${providerJobId}`));
  }

  async resultSize(providerJobId: string): Promise<number | null> {
    if (!/^[a-zA-Z0-9-]+$/u.test(providerJobId))
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
    const result = await json(
      await this.openEo(`/jobs/${providerJobId}/results`),
    );
    const assets = record(result.assets);
    const sizes = await Promise.all(
      Object.values(assets).map(async (asset) => {
        const metadata = record(asset);
        const size = metadata["file:size"] ?? metadata.size;
        if (size === undefined) {
          if (typeof metadata.href !== "string") return null;
          let assetUrl: URL;
          try {
            assetUrl = new URL(metadata.href);
          } catch {
            throw new ProviderError("INVALID_PROVIDER_RESPONSE");
          }
          if (
            assetUrl.protocol !== "https:" ||
            !assetUrl.hostname.endsWith(".dataspace.copernicus.eu") ||
            assetUrl.username !== "" ||
            assetUrl.password !== ""
          )
            throw new ProviderError("INVALID_PROVIDER_RESPONSE");
          const response = await request(
            this.fetcher,
            assetUrl.href,
            { method: "HEAD" },
            this.timeoutMs,
            this.now,
          );
          const contentLength = response.headers.get("content-length");
          if (contentLength === null) return null;
          const parsed = Number(contentLength);
          if (!Number.isSafeInteger(parsed) || parsed < 0)
            throw new ProviderError("INVALID_PROVIDER_RESPONSE");
          return parsed;
        }
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0)
          throw new ProviderError("INVALID_PROVIDER_RESPONSE");
        return size;
      }),
    );
    return sizes.length > 0 && sizes.every((size) => size !== null)
      ? sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0)
      : null;
  }
}

export interface UsageSnapshot {
  allowance: number;
  used: number;
  fetchedAt: string;
  accountingMonth: string;
  scope: "cdse-openeo-service-account";
  provenance: "provider-reported";
}

export function parseUsage(value: unknown, fetchedAt: string): UsageSnapshot {
  const account = record(value);
  // CDSE may expose only a remaining budget. That is insufficient to infer
  // the monthly allowance or usage, so ordinary dispatch remains closed.
  const allowance = nonnegative(account.monthly_allowance);
  const used = nonnegative(account.monthly_used);
  if (allowance <= 0 || used > allowance)
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  const timestamp = new Date(fetchedAt);
  if (
    !Number.isFinite(timestamp.valueOf()) ||
    timestamp.toISOString() !== fetchedAt
  )
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  return {
    allowance,
    used,
    fetchedAt,
    accountingMonth: fetchedAt.slice(0, 7),
    scope: "cdse-openeo-service-account",
    provenance: "provider-reported",
  };
}

export class UsageCache {
  private cached: UsageSnapshot | null = null;
  private pending: Promise<UsageSnapshot> | null = null;

  constructor(
    private readonly provider: Pick<CdseProvider, "account">,
    private readonly now: () => number = Date.now,
    private readonly lifetimeMs = 300_000,
  ) {
    if (lifetimeMs < 1_000 || lifetimeMs > 900_000)
      throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  }

  async current(): Promise<UsageSnapshot> {
    if (
      this.cached &&
      this.now() - Date.parse(this.cached.fetchedAt) < this.lifetimeMs
    )
      return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.provider
      .account()
      .then((account) => {
        const snapshot = parseUsage(
          account,
          new Date(this.now()).toISOString(),
        );
        this.cached = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  invalidate(): void {
    this.cached = null;
  }
}

export type AllocationBucket = "scheduled" | "retry" | "priority";
export type DispatchDecision =
  | { state: "queue"; reason: "WITHIN_FREE_QUOTA" | "REVIEWER_RELEASE" }
  | {
      state: "deferred_quota";
      reason:
        | "USAGE_UNAVAILABLE"
        | "P2_THRESHOLD"
        | "FREE_CREDITS_EXHAUSTED"
        | "BUCKET_EXHAUSTED"
        | "REVIEW_REQUIRED";
    };

export function decideDispatch(input: {
  priority: PilotJob["priority"];
  bucket: AllocationBucket;
  estimate: number;
  reservedTotal: number;
  reservedBucket: number;
  usage: UsageSnapshot | null;
  reviewerRelease: boolean;
  now: string;
  maxSnapshotAgeMs?: number;
  allowanceReference?: number;
}): DispatchDecision {
  const { priority, bucket, usage } = input;
  for (const value of [
    input.estimate,
    input.reservedTotal,
    input.reservedBucket,
  ])
    nonnegative(value);
  if (input.estimate === 0 || (priority === "P0" && bucket !== "priority"))
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  const reference = input.allowanceReference ?? 10_000;
  if (reference <= 0 || !Number.isFinite(reference))
    throw new ProviderError("INVALID_PROVIDER_RESPONSE");
  const age = usage
    ? Date.parse(input.now) - Date.parse(usage.fetchedAt)
    : Infinity;
  const fresh =
    usage !== null && age >= 0 && age <= (input.maxSnapshotAgeMs ?? 300_000);
  if (!fresh) {
    if (priority === "P2")
      return { state: "deferred_quota", reason: "USAGE_UNAVAILABLE" };
    if (!input.reviewerRelease)
      return { state: "deferred_quota", reason: "REVIEW_REQUIRED" };
    // A manual release is narrow and auditable. The reference is a ceiling for
    // local reservations, never a claim about the provider's current balance.
    if (input.reservedTotal + input.estimate > reference * 0.2)
      return { state: "deferred_quota", reason: "BUCKET_EXHAUSTED" };
    return { state: "queue", reason: "REVIEWER_RELEASE" };
  }
  const snapshot = usage;
  const projected = snapshot.used + input.reservedTotal + input.estimate;
  if (projected > snapshot.allowance)
    return { state: "deferred_quota", reason: "FREE_CREDITS_EXHAUSTED" };
  if (priority === "P2" && projected >= snapshot.allowance * 0.8)
    return { state: "deferred_quota", reason: "P2_THRESHOLD" };
  const fraction = bucket === "scheduled" ? 0.6 : 0.2;
  if (input.reservedBucket + input.estimate > snapshot.allowance * fraction)
    return { state: "deferred_quota", reason: "BUCKET_EXHAUSTED" };
  return { state: "queue", reason: "WITHIN_FREE_QUOTA" };
}
