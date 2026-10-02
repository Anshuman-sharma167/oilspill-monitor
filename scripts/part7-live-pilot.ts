import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  CdseAuth,
  CdseProvider,
  minimalJobDefinition,
  PART7_GRAPH_VERSION,
  ProviderError,
  readPart7Config,
  type PilotJob,
} from "../services/worker/src/part7.js";
import { processingJobId, sceneId } from "../packages/schemas/src/identity.js";

const evidencePath = resolve("evidence/part7-live-pilot.json");
const publicSceneId =
  "S1A_IW_GRDH_1SDV_20250131T010348_20250131T010403_057681_071BF1_F170_COG";
const sourceSceneId = sceneId("cdse-stac", publicSceneId, "sentinel-1-grd");
const pilot: PilotJob = {
  localJobId: processingJobId(
    sourceSceneId,
    "aoi:western-coast-shadow-pilot",
    PART7_GRAPH_VERSION,
    "1.0.0",
  ),
  aoiId: "aoi:western-coast-shadow-pilot",
  policyVersion: "1.0.0",
  priority: "P1",
  sceneId: sourceSceneId,
  bbox: { west: 71.5, south: 18.1, east: 71.505, north: 18.105 },
  from: "2025-01-31T00:00:00.000Z",
  to: "2025-01-31T23:59:59.000Z",
};

type ProviderState =
  "created" | "queued" | "running" | "finished" | "error" | "canceled";

interface Evidence {
  evidence_version: "1.0.0";
  graph_version: string;
  local_job_id: string;
  provider_job_id: string;
  provider_status: ProviderState;
  submitted_at: string;
  start_requested_at?: string;
  last_observed_at: string;
  provider_started_at?: string;
  provider_updated_at?: string;
  completed_at?: string;
  billed_credits?: number;
  output_bytes?: number;
  actual_cost_provenance: "provider-reported" | "unavailable";
  output_size_provenance: "provider-reported" | "unavailable";
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function readEvidence(): Promise<Evidence | null> {
  try {
    const value = JSON.parse(await readFile(evidencePath, "utf8")) as Evidence;
    if (
      value.evidence_version !== "1.0.0" ||
      value.graph_version !== PART7_GRAPH_VERSION ||
      value.local_job_id !== pilot.localJobId ||
      !/^[A-Za-z0-9-]+$/u.test(value.provider_job_id)
    )
      throw new Error("PART7_EVIDENCE_INVALID");
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

async function saveEvidence(value: Evidence): Promise<void> {
  await mkdir(dirname(evidencePath), { recursive: true });
  const temporaryPath = `${evidencePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });
  await rename(temporaryPath, evidencePath);
}

const timestamp = (value: unknown): string | undefined =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;

const providerState = (value: unknown): ProviderState => {
  if (
    value === "created" ||
    value === "queued" ||
    value === "running" ||
    value === "finished" ||
    value === "error" ||
    value === "canceled"
  )
    return value;
  throw new Error("PART7_INVALID_JOB_STATUS");
};

async function main(): Promise<void> {
  const config = readPart7Config();
  if (!config.dispatchEnabled) throw new Error("PART7_DISPATCH_DISABLED");

  const provider = new CdseProvider(CdseAuth.fromEnvironment());
  const stac = await provider.verifyStac(
    [pilot.bbox.west, pilot.bbox.south, pilot.bbox.east, pilot.bbox.north],
    pilot.from.slice(0, 10),
  );
  if (
    !stac.features.some(
      (item) =>
        sceneId("cdse-stac", item.id, item.collection) === pilot.sceneId &&
        item.polarizations.includes("VV") &&
        item.polarizations.includes("VH"),
    )
  )
    throw new Error("PART7_SCENE_BANDS_UNAVAILABLE");
  await provider.verifyCollection(config.collectionId, config.bands);

  const existingEvidence = await readEvidence();
  let evidence: Evidence;
  if (existingEvidence === null) {
    const submittedAt = new Date().toISOString();
    const providerJobId = await provider.createJob(
      minimalJobDefinition(pilot, config.collectionId, config.bands),
    );
    evidence = {
      evidence_version: "1.0.0",
      graph_version: PART7_GRAPH_VERSION,
      local_job_id: pilot.localJobId,
      provider_job_id: providerJobId,
      provider_status: "created",
      submitted_at: submittedAt,
      last_observed_at: submittedAt,
      actual_cost_provenance: "unavailable",
      output_size_provenance: "unavailable",
    };
    await saveEvidence(evidence);
    console.log(`PART7_JOB_SUBMITTED=${providerJobId}`);
  } else {
    evidence = existingEvidence;
    console.log(`PART7_JOB_RESUMED=${evidence.provider_job_id}`);
  }

  let status = await provider.jobStatus(evidence.provider_job_id);
  let state = providerState(status.status);
  if (state === "created" && evidence.start_requested_at === undefined) {
    evidence.start_requested_at = new Date().toISOString();
    await saveEvidence(evidence);
    await provider.startJob(evidence.provider_job_id);
    console.log("PART7_JOB_START_REQUESTED=PASS");
  }

  const deadline = Date.now() + 30 * 60 * 1000;
  let previousState: ProviderState | null = null;
  while (Date.now() < deadline) {
    status = await provider.jobStatus(evidence.provider_job_id);
    state = providerState(status.status);
    const observedAt = new Date().toISOString();
    const cost = status.costs;
    if (
      cost !== undefined &&
      (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)
    )
      throw new Error("PART7_INVALID_COST");
    const nextEvidence: Evidence = {
      ...evidence,
      provider_status: state,
      last_observed_at: observedAt,
      actual_cost_provenance:
        typeof cost === "number" ? "provider-reported" : "unavailable",
      ...(typeof cost === "number" ? { billed_credits: cost } : {}),
    };
    const startedAt = timestamp(status.started);
    const updatedAt = timestamp(status.updated);
    if (startedAt !== undefined) nextEvidence.provider_started_at = startedAt;
    if (updatedAt !== undefined) nextEvidence.provider_updated_at = updatedAt;
    evidence = nextEvidence;
    if (state !== previousState) {
      console.log(`PART7_JOB_STATUS=${state}`);
      previousState = state;
    }
    if (state === "finished") {
      const size = await provider.resultSize(evidence.provider_job_id);
      evidence.completed_at = observedAt;
      evidence.output_size_provenance =
        size === null ? "unavailable" : "provider-reported";
      if (size !== null) evidence.output_bytes = size;
      await saveEvidence(evidence);
      console.log("PART7_LIVE_PILOT=PASS");
      console.log(`BILLED_CREDITS=${evidence.billed_credits ?? "UNAVAILABLE"}`);
      console.log(`OUTPUT_BYTES=${evidence.output_bytes ?? "UNAVAILABLE"}`);
      return;
    }
    await saveEvidence(evidence);
    if (state === "error" || state === "canceled")
      throw new Error(`PART7_PROVIDER_JOB_${state.toUpperCase()}`);
    await sleep(15_000);
  }
  throw new Error("PART7_OBSERVE_TIMEOUT");
}

try {
  await main();
} catch (error) {
  const code =
    error instanceof ProviderError
      ? error.code
      : error instanceof Error
        ? error.message
        : "PART7_UNKNOWN_ERROR";
  console.error(`PART7_LIVE_PILOT=FAIL CODE=${code}`);
  process.exitCode = 1;
}
