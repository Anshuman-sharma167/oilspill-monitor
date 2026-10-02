import { readFileSync } from "node:fs";

import { contractModelNames } from "./generated.js";

type JsonSchema = {
  $ref?: string;
  const?: unknown;
  enum?: unknown[];
  oneOf?: JsonSchema[];
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  $defs?: Record<string, JsonSchema>;
};

const schema = JSON.parse(
  readFileSync(
    new URL("../schema/contracts.schema.json", import.meta.url),
    "utf8",
  ),
) as JsonSchema;

export type ContractModelName = (typeof contractModelNames)[number];

export class ContractValidationError extends Error {}

const fail = (path: string, message: string): never => {
  throw new ContractValidationError(`${path}: ${message}`);
};

const resolveReference = (reference: string): JsonSchema => {
  const name = reference.split("/").at(-1);
  const resolved = name === undefined ? undefined : schema.$defs?.[name];
  if (resolved === undefined)
    throw new Error(`Unknown schema reference ${reference}`);
  return resolved;
};

const validateNode = (rule: JsonSchema, value: unknown, path: string): void => {
  if (rule.$ref !== undefined) {
    validateNode(resolveReference(rule.$ref), value, path);
    return;
  }
  if (rule.const !== undefined && value !== rule.const)
    fail(path, `must equal ${JSON.stringify(rule.const)}`);
  if (rule.enum !== undefined && !rule.enum.includes(value))
    fail(path, "contains an unsupported value");
  if (rule.oneOf !== undefined) {
    const matches = rule.oneOf.filter((option) => {
      try {
        validateNode(option, value, path);
        return true;
      } catch (error) {
        if (error instanceof ContractValidationError) return false;
        throw error;
      }
    });
    if (matches.length !== 1)
      fail(path, "must match exactly one allowed shape");
    return;
  }
  if (rule.type === "null") {
    if (value !== null) fail(path, "must be null");
    return;
  }
  if (rule.type === "string") {
    if (typeof value !== "string") fail(path, "must be a string");
    const text = value as string;
    if (rule.minLength !== undefined && text.length < rule.minLength)
      fail(path, `must contain at least ${rule.minLength} characters`);
    if (rule.maxLength !== undefined && text.length > rule.maxLength)
      fail(path, `must contain at most ${rule.maxLength} characters`);
    if (rule.pattern !== undefined && !new RegExp(rule.pattern, "u").test(text))
      fail(path, "does not match the required pattern");
    if (rule.format === "date-time") {
      const parsed = new Date(text);
      if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== text)
        fail(path, "must be a canonical ISO 8601 UTC timestamp");
    }
    if (rule.format === "uri") {
      try {
        const parsed = new URL(text);
        if (parsed.protocol.length === 0) fail(path, "must be an absolute URI");
      } catch {
        fail(path, "must be an absolute URI");
      }
    }
    return;
  }
  if (rule.type === "number" || rule.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value))
      fail(path, "must be a finite number");
    const numeric = value as number;
    if (rule.type === "integer" && !Number.isInteger(numeric))
      fail(path, "must be an integer");
    if (rule.minimum !== undefined && numeric < rule.minimum)
      fail(path, `must be at least ${rule.minimum}`);
    if (rule.maximum !== undefined && numeric > rule.maximum)
      fail(path, `must be at most ${rule.maximum}`);
    return;
  }
  if (rule.type === "boolean") {
    if (typeof value !== "boolean") fail(path, "must be a boolean");
    return;
  }
  if (rule.type === "array") {
    if (!Array.isArray(value)) fail(path, "must be an array");
    const items = value as unknown[];
    if (rule.minItems !== undefined && items.length < rule.minItems)
      fail(path, `must contain at least ${rule.minItems} items`);
    if (rule.maxItems !== undefined && items.length > rule.maxItems)
      fail(path, `must contain at most ${rule.maxItems} items`);
    items.forEach((item, index) => {
      const itemRule = rule.prefixItems?.[index] ?? rule.items;
      if (itemRule !== undefined)
        validateNode(itemRule, item, `${path}[${index}]`);
    });
    return;
  }
  if (rule.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      fail(path, "must be an object");
    const record = value as Record<string, unknown>;
    for (const required of rule.required ?? []) {
      if (!(required in record)) fail(`${path}.${required}`, "is required");
    }
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in (rule.properties ?? {})))
          fail(`${path}.${key}`, "is not an allowed property");
      }
    }
    for (const [key, propertyRule] of Object.entries(rule.properties ?? {})) {
      if (key in record)
        validateNode(propertyRule, record[key], `${path}.${key}`);
    }
  }
};

type Position = [number, number];
type LinearRing = Position[];

const polygonsFromGeometry = (
  geometry: Record<string, unknown>,
): LinearRing[][] => {
  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates)) return [];
  if (geometry.type === "Polygon") return [coordinates as LinearRing[]];
  return coordinates as LinearRing[][];
};

const signedArea = (ring: LinearRing): number =>
  ring.slice(0, -1).reduce((area, point, index) => {
    const next = ring[index + 1];
    return next === undefined
      ? area
      : area + point[0] * next[1] - next[0] * point[1];
  }, 0) / 2;

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

const ringSelfIntersects = (ring: LinearRing): boolean => {
  const segmentCount = ring.length - 1;
  for (let first = 0; first < segmentCount; first += 1) {
    const a = ring[first];
    const b = ring[first + 1];
    if (a === undefined || b === undefined) continue;
    for (let second = first + 1; second < segmentCount; second += 1) {
      if (second === first + 1 || (first === 0 && second === segmentCount - 1))
        continue;
      const c = ring[second];
      const d = ring[second + 1];
      if (c !== undefined && d !== undefined && segmentsIntersect(a, b, c, d))
        return true;
    }
  }
  return false;
};

const validateGeometry = (value: Record<string, unknown>): void => {
  for (const polygon of polygonsFromGeometry(value)) {
    polygon.forEach((ring, ringIndex) => {
      const first = ring[0];
      const last = ring.at(-1);
      if (JSON.stringify(first) !== JSON.stringify(last))
        fail("$.geometry", "GeoJSON linear rings must be closed");
      const area = signedArea(ring);
      if (area === 0) fail("$.geometry", "GeoJSON rings must not be empty");
      if ((ringIndex === 0 && area < 0) || (ringIndex > 0 && area > 0))
        fail("$.geometry", "GeoJSON rings must use right-hand-rule winding");
      if (ringSelfIntersects(ring))
        fail("$.geometry", "GeoJSON rings must not self-intersect");
    });
  }
};

const validateAoiSemantics = (value: Record<string, unknown>): void => {
  const validFrom = new Date(value.valid_from as string).valueOf();
  const validTo = value.valid_to;
  if (validTo !== null && new Date(validTo as string).valueOf() <= validFrom)
    fail("$.valid_to", "must be later than valid_from");
  if (
    value.enabled === true &&
    (value.cost_estimate_status !== "estimated" ||
      value.approximate_openeo_credits === null)
  )
    fail(
      "$.enabled",
      "requires a recorded provider cost estimate before activation",
    );
};

const validateJobSemantics = (value: Record<string, unknown>): void => {
  const state = value.state as string;
  const stateTimestamp = `${state}_at`;
  if (value[stateTimestamp] === null)
    fail(`$.${stateTimestamp}`, "is required for the current state");
  const ordered = [
    "discovered_at",
    "queued_at",
    "preprocessing_at",
    "inferencing_at",
    "ready_for_review_at",
  ];
  let previous = -Infinity;
  for (const field of ordered) {
    const timestamp = value[field];
    if (timestamp === null) continue;
    const current = new Date(timestamp as string).valueOf();
    if (current < previous)
      fail(`$.${field}`, "transition timestamps must be monotonic");
    previous = current;
  }
  const prerequisites: Record<string, string[]> = {
    queued: ["queued_at"],
    preprocessing: ["queued_at", "preprocessing_at"],
    inferencing: ["queued_at", "preprocessing_at", "inferencing_at"],
    ready_for_review: [
      "queued_at",
      "preprocessing_at",
      "inferencing_at",
      "ready_for_review_at",
    ],
  };
  for (const field of prerequisites[state] ?? []) {
    if (value[field] === null)
      fail(`$.${field}`, `is required in ${state} state`);
  }
  if (state === "failed") {
    if (value.failure === null)
      fail("$.failure", "is required in failed state");
  } else if (value.failure !== null || value.failed_at !== null) {
    fail("$.failure", "is only allowed in failed state");
  }
};

const validateProviderAccounting = (
  modelName: ContractModelName,
  value: Record<string, unknown>,
): void => {
  if (
    modelName === "ProviderUsageSnapshot" &&
    (value.used as number) > (value.allowance as number)
  )
    fail("$.used", "must not exceed the provider allowance");
  if (modelName === "ProviderJobRun") {
    if (
      (value.actual_credits === null) !==
      (value.actual_provenance === "unavailable")
    )
      fail("$.actual_provenance", "must match actual-credit availability");
    if (value.state === "finished" && value.completed_at === null)
      fail("$.completed_at", "is required for a finished job");
    if ((value.provider_job_id === null) !== (value.submitted_at === null))
      fail("$.submitted_at", "must match provider-job availability");
  }
  if (
    modelName === "CreditLedgerEntry" &&
    value.entry_kind !== "adjustment" &&
    (value.credits as number) < 0
  )
    fail("$.credits", "must be non-negative for this entry kind");
};

const assetMediaTypes: Record<string, string> = {
  context_webp: "image/webp",
  detail_webp: "image/webp",
  probability_cog: "image/tiff; application=geotiff",
  mask_cog: "image/tiff; application=geotiff",
  report_json: "application/json",
};

export const validateContract = (
  modelName: ContractModelName,
  value: unknown,
): void => {
  const definition = schema.$defs?.[modelName];
  if (definition === undefined)
    throw new Error(`Unknown contract model ${modelName}`);
  validateNode(definition, value, "$");
  const record = value as Record<string, unknown>;
  if (modelName === "AOI") {
    validateGeometry(record.geometry as Record<string, unknown>);
    validateAoiSemantics(record);
  }
  if (modelName === "Scene")
    validateGeometry(record.footprint as Record<string, unknown>);
  if (modelName === "Candidate")
    validateGeometry(record.geometry as Record<string, unknown>);
  if (modelName === "ProcessingJob") validateJobSemantics(record);
  validateProviderAccounting(modelName, record);
  if (
    modelName === "CandidateAsset" &&
    assetMediaTypes[record.asset_type as string] !== record.media_type
  ) {
    fail("$.media_type", "does not match the versioned asset layout");
  }
  if (
    modelName === "AlertDelivery" &&
    (record.state === "delivered") !== (record.delivered_at !== null)
  ) {
    fail("$.delivered_at", "must be set exactly when delivery is complete");
  }
};
