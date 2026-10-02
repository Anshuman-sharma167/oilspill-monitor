const STAC_ORIGIN = "https://stac.dataspace.copernicus.eu";
export const PART8_STAC_URL = `${STAC_ORIGIN}/v1/search`;
export const PART8_PROVIDER = "cdse-stac";
export const PART8_COLLECTION = "sentinel-1-grd";
export const PART8_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const PART8_MAX_POLYGONS = 64;
export const PART8_MAX_RINGS_PER_POLYGON = 32;
export const PART8_MAX_RING_POSITIONS = 512;
export const PART8_MAX_GEOMETRY_POSITIONS = 4_096;

export type Part8ErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_PROVIDER_RESPONSE"
  | "RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PERSISTENCE_FAILED"
  | "UNAUTHORIZED"
  | "UNSAFE_PAGINATION"
  | "LIMIT_EXCEEDED";

export class Part8Error extends Error {
  override name = "Part8Error";
  constructor(
    readonly code: Part8ErrorCode,
    readonly retryAfterMs: number | null = null,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export interface Part8Config {
  enabled: boolean;
  overlapMinutes: number;
  pageSize: number;
  maxPages: number;
  maxItems: number;
  requestTimeoutMs: number;
  retryAttempts: number;
  initialRetryDelayMs: number;
  maxRetryDelayMs: number;
  preprocessingVersion: string;
  modelVersion: string;
}

const integer = (
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = environment[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Part8Error("INVALID_CONFIG");
  return value;
};

const version = (value: string | undefined, fallback: string): string => {
  const resolved = value || fallback;
  if (!/^\d+\.\d+\.\d+$/u.test(resolved))
    throw new Part8Error("INVALID_CONFIG");
  return resolved;
};

export function readPart8Config(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Part8Config {
  const enabled = environment.PART8_DISCOVERY_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false")
    throw new Part8Error("INVALID_CONFIG");
  const initialRetryDelayMs = integer(
    environment,
    "PART8_INITIAL_RETRY_DELAY_MS",
    250,
    1,
    30_000,
  );
  const maxRetryDelayMs = integer(
    environment,
    "PART8_MAX_RETRY_DELAY_MS",
    5_000,
    initialRetryDelayMs,
    300_000,
  );
  return {
    enabled: enabled === "true",
    overlapMinutes: integer(
      environment,
      "PART8_POLL_OVERLAP_MINUTES",
      60,
      45,
      1_440,
    ),
    pageSize: integer(environment, "PART8_STAC_PAGE_SIZE", 100, 1, 1_000),
    maxPages: integer(environment, "PART8_MAX_PAGES", 20, 1, 100),
    maxItems: integer(environment, "PART8_MAX_ITEMS", 5_000, 1, 50_000),
    requestTimeoutMs: integer(
      environment,
      "PART8_REQUEST_TIMEOUT_MS",
      10_000,
      100,
      60_000,
    ),
    retryAttempts: integer(environment, "PART8_RETRY_ATTEMPTS", 3, 1, 8),
    initialRetryDelayMs,
    maxRetryDelayMs,
    preprocessingVersion: version(
      environment.PART8_PREPROCESSING_VERSION,
      "1.0.0",
    ),
    modelVersion: version(environment.PART8_MODEL_VERSION, "1.0.0"),
  };
}

export interface PollWindow {
  startedAt: string;
  from: string;
  to: string;
}

export const pollWindow = (
  startedAt: Date,
  overlapMinutes: number,
): PollWindow => {
  if (
    !Number.isFinite(startedAt.valueOf()) ||
    !Number.isSafeInteger(overlapMinutes) ||
    overlapMinutes < 45
  )
    throw new Part8Error("INVALID_CONFIG");
  return {
    startedAt: startedAt.toISOString(),
    from: new Date(startedAt.valueOf() - overlapMinutes * 60_000).toISOString(),
    to: startedAt.toISOString(),
  };
};

export interface EnabledAoi {
  aoiId: string;
  policyVersion: string;
  geometry: Record<string, unknown>;
}

export interface AssetReference {
  key: string;
  href: string;
  type?: string;
  roles?: string[];
}

export type PolarizationDisposition =
  "dual_band" | "missing_vh" | "invalid_polarization";

export interface NormalizedScene {
  sceneId: string;
  sourceProvider: typeof PART8_PROVIDER;
  collection: string;
  providerItemId: string;
  acquisitionStart: string;
  acquisitionEnd: string;
  platform: string;
  orbitDirection: "ascending" | "descending";
  relativeOrbit: number;
  productType: "IW_GRDH_1S";
  polarizations: string[];
  footprint: Record<string, unknown>;
  publishedAt: string | null;
  firstDiscoveredAt: string;
  lastDiscoveredAt: string;
  assets: AssetReference[];
  rawMetadataChecksum: string;
  polarizationDisposition: PolarizationDisposition;
}

export interface DiscoveryMetrics {
  providerRequestId: string | null;
  pagesFetched: number;
  rawItemCount: number;
  uniqueItemCount: number;
  normalizedItemCount: number;
  rejectedItemCount: number;
  missingVhCount: number;
  createdSceneCount: number;
  updatedSceneCount: number;
  createdJobCount: number;
  existingJobCount: number;
  durationMs: number;
  warnings: string[];
}

export interface PollResult extends DiscoveryMetrics {
  pollRunId: number | null;
}

export interface CompletePollInput {
  window: PollWindow;
  scenes: NormalizedScene[];
  metrics: DiscoveryMetrics;
  preprocessingVersion: string;
  modelVersion: string;
}

export interface PersistenceResult {
  pollRunId: number;
  createdSceneCount: number;
  updatedSceneCount: number;
  createdJobCount: number;
  existingJobCount: number;
}

export interface DiscoveryDatabase {
  enabledAois(at: string): Promise<EnabledAoi[]>;
  complete(input: CompletePollInput): Promise<PersistenceResult>;
  fail(input: {
    window: PollWindow;
    code: Part8ErrorCode;
    durationMs: number;
  }): Promise<number | null>;
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DiscoveryDependencies {
  database: DiscoveryDatabase;
  fetcher?: Fetcher;
  now?: () => Date;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  config?: Part8Config;
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Part8Error("INVALID_PROVIDER_RESPONSE");
  return value as Record<string, unknown>;
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

export async function authenticateCron(
  provided: string | null,
  expected: string,
): Promise<boolean> {
  if (provided === null || expected.length < 32) return false;
  const [left, right] = await Promise.all([sha256(provided), sha256(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1)
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export const catalogueSceneId = async (
  provider: string,
  collection: string,
  providerItemId: string,
): Promise<string> =>
  `scene:${(await sha256([provider, collection, providerItemId].join("\u001f"))).slice(0, 32)}`;

type Position = [number, number];
type Ring = Position[];

const orientation = (a: Position, b: Position, c: Position): number =>
  Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));

const segmentsIntersect = (
  a: Position,
  b: Position,
  c: Position,
  d: Position,
): boolean =>
  orientation(a, b, c) !== orientation(a, b, d) &&
  orientation(c, d, a) !== orientation(c, d, b);

const validRing = (value: unknown): value is Ring => {
  if (
    !Array.isArray(value) ||
    value.length < 4 ||
    value.length > PART8_MAX_RING_POSITIONS
  )
    return false;
  const ring = value as unknown[];
  if (
    !ring.every(
      (point) =>
        Array.isArray(point) &&
        point.length === 2 &&
        typeof point[0] === "number" &&
        Number.isFinite(point[0]) &&
        point[0] >= -180 &&
        point[0] <= 180 &&
        typeof point[1] === "number" &&
        Number.isFinite(point[1]) &&
        point[1] >= -90 &&
        point[1] <= 90,
    )
  )
    return false;
  const typed = value as Ring;
  if (canonical(typed[0]) !== canonical(typed.at(-1))) return false;
  const area = typed.slice(0, -1).reduce((sum, point, index) => {
    const next = typed[index + 1];
    return next === undefined
      ? sum
      : sum + point[0] * next[1] - next[0] * point[1];
  }, 0);
  if (area === 0) return false;
  const segments = typed.length - 1;
  for (let first = 0; first < segments; first += 1) {
    for (let second = first + 1; second < segments; second += 1) {
      if (second === first + 1 || (first === 0 && second === segments - 1))
        continue;
      const a = typed[first];
      const b = typed[first + 1];
      const c = typed[second];
      const d = typed[second + 1];
      if (a && b && c && d && segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
};

export const validGeometry = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const geometry = value as Record<string, unknown>;
  if (geometry.type === "Polygon")
    return (
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length > 0 &&
      geometry.coordinates.length <= PART8_MAX_RINGS_PER_POLYGON &&
      geometry.coordinates.reduce(
        (total, ring) => total + (Array.isArray(ring) ? ring.length : 0),
        0,
      ) <= PART8_MAX_GEOMETRY_POSITIONS &&
      geometry.coordinates.every(validRing)
    );
  if (geometry.type === "MultiPolygon")
    return (
      Array.isArray(geometry.coordinates) &&
      geometry.coordinates.length > 0 &&
      geometry.coordinates.length <= PART8_MAX_POLYGONS &&
      geometry.coordinates.reduce(
        (total, polygon) =>
          total +
          (Array.isArray(polygon)
            ? polygon.reduce(
                (polygonTotal, ring) =>
                  polygonTotal + (Array.isArray(ring) ? ring.length : 0),
                0,
              )
            : 0),
        0,
      ) <= PART8_MAX_GEOMETRY_POSITIONS &&
      geometry.coordinates.every(
        (polygon) =>
          Array.isArray(polygon) &&
          polygon.length > 0 &&
          polygon.length <= PART8_MAX_RINGS_PER_POLYGON &&
          polygon.every(validRing),
      )
    );
  return false;
};

const timestamp = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
};

const stableAsset = (key: string, value: unknown): AssetReference | null => {
  if (!/^[A-Za-z0-9_.:-]{1,100}$/u.test(key)) return null;
  const source = record(value);
  if (typeof source.href !== "string" || source.href.length > 2_000)
    return null;
  let parsed: URL;
  try {
    parsed = new URL(source.href);
  } catch {
    return null;
  }
  if (
    !["https:", "s3:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    return null;
  parsed.search = "";
  parsed.hash = "";
  const output: AssetReference = { key, href: parsed.toString() };
  if (typeof source.type === "string" && source.type.length <= 200)
    output.type = source.type;
  if (
    Array.isArray(source.roles) &&
    source.roles.length <= 10 &&
    source.roles.every((role) => typeof role === "string" && role.length <= 50)
  )
    output.roles = [...source.roles].sort() as string[];
  return output;
};

export async function normalizeStacItem(
  value: unknown,
  discoveredAt: string,
): Promise<NormalizedScene> {
  const item = record(value);
  const properties = record(item.properties);
  if (
    item.type !== "Feature" ||
    typeof item.id !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,200}$/u.test(item.id) ||
    item.collection !== PART8_COLLECTION ||
    properties["sar:instrument_mode"] !== "IW" ||
    properties["product:type"] !== "IW_GRDH_1S" ||
    !validGeometry(item.geometry)
  )
    throw new Part8Error("INVALID_PROVIDER_RESPONSE");
  const start = timestamp(properties.start_datetime ?? properties.datetime);
  const end = timestamp(
    properties.end_datetime ?? properties.datetime ?? properties.start_datetime,
  );
  const publishedAt = timestamp(properties.published ?? properties.created);
  const orbitDirection = String(
    properties["sat:orbit_state"] ?? "",
  ).toLowerCase();
  const relativeOrbit = properties["sat:relative_orbit"];
  const platform = String(properties.platform ?? "").toLowerCase();
  if (
    start === null ||
    end === null ||
    Date.parse(end) < Date.parse(start) ||
    !/^sentinel-1[abc]$/u.test(platform) ||
    (orbitDirection !== "ascending" && orbitDirection !== "descending") ||
    !Number.isSafeInteger(relativeOrbit) ||
    (relativeOrbit as number) < 1
  )
    throw new Part8Error("INVALID_PROVIDER_RESPONSE");
  const rawPolarizations = properties["sar:polarizations"];
  if (!Array.isArray(rawPolarizations) || rawPolarizations.length === 0)
    throw new Part8Error("INVALID_PROVIDER_RESPONSE");
  const polarizations = [
    ...new Set(
      rawPolarizations.map((band) =>
        typeof band === "string" ? band.toUpperCase() : "",
      ),
    ),
  ].sort();
  if (polarizations.some((band) => !["HH", "HV", "VH", "VV"].includes(band)))
    throw new Part8Error("INVALID_PROVIDER_RESPONSE");
  const polarizationDisposition: PolarizationDisposition =
    polarizations.includes("VV")
      ? polarizations.includes("VH")
        ? "dual_band"
        : "missing_vh"
      : "invalid_polarization";
  const assets = Object.entries(record(item.assets))
    .map(([key, asset]) => stableAsset(key, asset))
    .filter((asset): asset is AssetReference => asset !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
  const checksumInput = {
    collection: item.collection,
    providerItemId: item.id,
    acquisitionStart: start,
    acquisitionEnd: end,
    platform,
    orbitDirection,
    relativeOrbit,
    productType: properties["product:type"],
    polarizations,
    footprint: item.geometry,
    publishedAt,
    assets,
    polarizationDisposition,
  };
  return {
    sceneId: await catalogueSceneId(PART8_PROVIDER, PART8_COLLECTION, item.id),
    sourceProvider: PART8_PROVIDER,
    collection: PART8_COLLECTION,
    providerItemId: item.id,
    acquisitionStart: start,
    acquisitionEnd: end,
    platform,
    orbitDirection,
    relativeOrbit: relativeOrbit as number,
    productType: "IW_GRDH_1S",
    polarizations,
    footprint: item.geometry,
    publishedAt,
    firstDiscoveredAt: discoveredAt,
    lastDiscoveredAt: discoveredAt,
    assets,
    rawMetadataChecksum: await sha256(canonical(checksumInput)),
    polarizationDisposition,
  };
}

export const stacSearchBody = (
  geometry: Record<string, unknown>,
  window: PollWindow,
  pageSize: number,
): Record<string, unknown> => {
  if (!validGeometry(geometry) || pageSize < 1 || pageSize > 1_000)
    throw new Part8Error("INVALID_CONFIG");
  return {
    collections: [PART8_COLLECTION],
    datetime: `${window.from}/${window.to}`,
    intersects: geometry,
    limit: pageSize,
    "filter-lang": "cql2-json",
    filter: {
      op: "and",
      args: [
        {
          op: "=",
          args: [{ property: "sar:instrument_mode" }, "IW"],
        },
        {
          op: "=",
          args: [{ property: "product:type" }, "IW_GRDH_1S"],
        },
      ],
    },
  };
};

const retryAfter = (value: string | null, now: number, maximum: number) => {
  if (value === null) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, maximum) : null;
};

const transient = (error: unknown): error is Part8Error =>
  error instanceof Part8Error &&
  ["RATE_LIMITED", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE"].includes(
    error.code,
  );

async function requestPage(
  fetcher: Fetcher,
  url: URL,
  body: Record<string, unknown>,
  config: Part8Config,
  now: () => Date,
  random: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<Response> {
  let last: Part8Error | null = null;
  for (let attempt = 0; attempt < config.retryAttempts; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (response.status === 429)
        throw new Part8Error(
          "RATE_LIMITED",
          retryAfter(
            response.headers.get("retry-after"),
            now().valueOf(),
            config.maxRetryDelayMs,
          ),
        );
      if (response.status >= 500) throw new Part8Error("PROVIDER_UNAVAILABLE");
      if (!response.ok) throw new Part8Error("INVALID_PROVIDER_RESPONSE");
      return response;
    } catch (error) {
      if (error instanceof Part8Error) last = error;
      else if (
        error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
      )
        last = new Part8Error("PROVIDER_TIMEOUT");
      else last = new Part8Error("PROVIDER_UNAVAILABLE");
      if (!transient(last) || attempt + 1 >= config.retryAttempts) throw last;
      const exponential = Math.min(
        config.maxRetryDelayMs,
        config.initialRetryDelayMs * 2 ** attempt,
      );
      const jittered = Math.min(
        config.maxRetryDelayMs,
        Math.round(exponential * (0.5 + random() * 0.5)),
      );
      await sleep(last.retryAfterMs ?? jittered);
    }
  }
  throw last ?? new Part8Error("PROVIDER_UNAVAILABLE");
}

async function boundedJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > PART8_MAX_RESPONSE_BYTES)
  )
    throw new Part8Error("LIMIT_EXCEEDED");
  if (response.body === null) throw new Part8Error("INVALID_PROVIDER_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > PART8_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Part8Error("LIMIT_EXCEEDED");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error instanceof Part8Error) throw error;
    throw new Part8Error("INVALID_PROVIDER_RESPONSE", null, { cause: error });
  } finally {
    reader.releaseLock();
  }
}

const sameSearch = (
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): boolean =>
  [
    "collections",
    "datetime",
    "intersects",
    "limit",
    "filter-lang",
    "filter",
  ].every((key) => canonical(expected[key]) === canonical(actual[key]));

const nextRequest = (
  payload: Record<string, unknown>,
  currentBody: Record<string, unknown>,
  seen: Set<string>,
): { url: URL; body: Record<string, unknown> } | null => {
  if (!Array.isArray(payload.links)) return null;
  const link = payload.links
    .map((value) => record(value))
    .find((value) => value.rel === "next");
  if (link === undefined) return null;
  if (typeof link.href !== "string" || String(link.method ?? "GET") !== "POST")
    throw new Part8Error("UNSAFE_PAGINATION");
  const url = new URL(link.href, PART8_STAC_URL);
  if (
    url.protocol !== "https:" ||
    url.origin !== STAC_ORIGIN ||
    url.pathname !== "/v1/search" ||
    url.username ||
    url.password
  )
    throw new Part8Error("UNSAFE_PAGINATION");
  const body = record(link.body);
  if (!sameSearch(currentBody, body) || !("token" in body))
    throw new Part8Error("UNSAFE_PAGINATION");
  const key = `${url.toString()}\u001f${canonical(body.token)}`;
  if (seen.has(key)) throw new Part8Error("UNSAFE_PAGINATION");
  seen.add(key);
  return { url, body };
};

const sanitizedWarnings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((warning): warning is string => typeof warning === "string")
        .map((warning) =>
          warning.replace(/https?:\/\/\S+/giu, "[redacted-url]").slice(0, 200),
        )
        .slice(0, 10)
    : [];

export class DiscoveryService {
  private readonly fetcher: Fetcher;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly config: Part8Config;

  constructor(private readonly dependencies: DiscoveryDependencies) {
    this.fetcher = dependencies.fetcher ?? fetch;
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.random ?? Math.random;
    this.sleep =
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.config = dependencies.config ?? readPart8Config();
  }

  async poll(): Promise<PollResult> {
    const began = this.now();
    const window = pollWindow(began, this.config.overlapMinutes);
    try {
      if (!this.config.enabled) throw new Part8Error("INVALID_CONFIG");
      const aois = await this.dependencies.database.enabledAois(
        window.startedAt,
      );
      const unique = new Map<string, unknown>();
      const warnings: string[] = [];
      let pagesFetched = 0;
      let rawItemCount = 0;
      let providerRequestId: string | null = null;
      for (const aoi of aois) {
        const initialBody = stacSearchBody(
          aoi.geometry,
          window,
          this.config.pageSize,
        );
        let request: { url: URL; body: Record<string, unknown> } | null = {
          url: new URL(PART8_STAC_URL),
          body: initialBody,
        };
        const seen = new Set<string>();
        while (request !== null) {
          if (pagesFetched >= this.config.maxPages)
            throw new Part8Error("LIMIT_EXCEEDED");
          const response = await requestPage(
            this.fetcher,
            request.url,
            request.body,
            this.config,
            this.now,
            this.random,
            this.sleep,
          );
          providerRequestId ??=
            response.headers.get("x-request-id") ??
            response.headers.get("traceparent");
          const payload = await boundedJson(response);
          if (
            payload.type !== "FeatureCollection" ||
            !Array.isArray(payload.features)
          )
            throw new Part8Error("INVALID_PROVIDER_RESPONSE");
          if (payload.features.length > this.config.pageSize)
            throw new Part8Error("LIMIT_EXCEEDED");
          pagesFetched += 1;
          rawItemCount += payload.features.length;
          if (rawItemCount > this.config.maxItems)
            throw new Part8Error("LIMIT_EXCEEDED");
          for (const item of payload.features) {
            try {
              const candidate = record(item);
              if (
                typeof candidate.id !== "string" ||
                typeof candidate.collection !== "string"
              )
                throw new Part8Error("INVALID_PROVIDER_RESPONSE");
              unique.set(`${candidate.collection}\u001f${candidate.id}`, item);
            } catch {
              unique.set(
                `invalid\u001f${pagesFetched}\u001f${unique.size}`,
                item,
              );
            }
          }
          warnings.push(...sanitizedWarnings(payload.warnings));
          request = nextRequest(payload, initialBody, seen);
        }
      }
      const scenes: NormalizedScene[] = [];
      let rejectedItemCount = 0;
      for (const item of unique.values()) {
        try {
          scenes.push(await normalizeStacItem(item, window.startedAt));
        } catch (error) {
          if (
            error instanceof Part8Error &&
            error.code === "INVALID_PROVIDER_RESPONSE"
          ) {
            rejectedItemCount += 1;
            continue;
          }
          throw error;
        }
      }
      const metrics: DiscoveryMetrics = {
        providerRequestId,
        pagesFetched,
        rawItemCount,
        uniqueItemCount: unique.size,
        normalizedItemCount: scenes.length,
        rejectedItemCount,
        missingVhCount: scenes.filter(
          (scene) => scene.polarizationDisposition === "missing_vh",
        ).length,
        createdSceneCount: 0,
        updatedSceneCount: 0,
        createdJobCount: 0,
        existingJobCount: 0,
        durationMs: Math.max(0, this.now().valueOf() - began.valueOf()),
        warnings: [...new Set(warnings)].slice(0, 10),
      };
      let persisted: PersistenceResult;
      try {
        persisted = await this.dependencies.database.complete({
          window,
          scenes,
          metrics,
          preprocessingVersion: this.config.preprocessingVersion,
          modelVersion: this.config.modelVersion,
        });
      } catch (error) {
        throw new Part8Error("PERSISTENCE_FAILED", null, { cause: error });
      }
      return { ...metrics, ...persisted };
    } catch (error) {
      const safe =
        error instanceof Part8Error
          ? error
          : new Part8Error("PERSISTENCE_FAILED");
      try {
        await this.dependencies.database.fail({
          window,
          code: safe.code,
          durationMs: Math.max(0, this.now().valueOf() - began.valueOf()),
        });
      } catch {
        // The original named failure remains the authoritative result.
      }
      throw safe;
    }
  }
}
