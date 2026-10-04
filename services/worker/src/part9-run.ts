import { readFile } from "node:fs/promises";

const jobId = process.env.JOB_ID ?? "";
const path = process.env.PART9_JOB_CONFIG_FILE ?? "";
if (!/^job:[0-9a-f]{32}$/u.test(jobId) || path.length === 0)
  throw new Error("INVALID_PART9_RUN_REQUEST");

const configuration = JSON.parse(await readFile(path, "utf8")) as {
  job_id?: unknown;
};
if (configuration.job_id !== jobId)
  throw new Error("PART9_JOB_CONFIGURATION_MISMATCH");

// The live route stays disabled until the OIDC-protected configuration service
// supplies a tested database adapter. This boundary deliberately prints no job
// configuration, credentials, provider identifiers, or asset references.
throw new Error("PART9_LIVE_WORKER_NOT_CONFIGURED");
