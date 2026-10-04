import { readFile } from "node:fs/promises";

import {
  Part9BrokerDatabase,
  validatePart9BrokerConfiguration,
} from "./part9-broker-database.js";
import { Part9Worker, readPart9Config } from "./part9.js";

const jobId = process.env.JOB_ID ?? "";
const path = process.env.PART9_JOB_CONFIG_FILE ?? "";
if (!/^job:[0-9a-f]{32}$/u.test(jobId) || path.length === 0)
  throw new Error("INVALID_PART9_RUN_REQUEST");

const configuration = validatePart9BrokerConfiguration(
  JSON.parse(await readFile(path, "utf8")) as unknown,
  jobId,
);
const queue = new Part9BrokerDatabase(configuration);
const worker = new Part9Worker(
  queue,
  {
    preprocessing: async (job) => ({
      bytes: Buffer.from(`part9-synthetic-preprocessing:${job.jobId}`, "utf8"),
      metadata: { synthetic: true },
    }),
    inferencing: async (job) => ({
      bytes: Buffer.from(`part9-synthetic-inferencing:${job.jobId}`, "utf8"),
      metadata: { synthetic: true },
    }),
  },
  readPart9Config({
    ...process.env,
    PART9_WORKER_ID: process.env.PART9_WORKER_ID ?? "worker:github-actions",
  }),
);
const result = await worker.runOne();
if (result === "empty") throw new Error("PART9_JOB_NOT_CLAIMABLE");
if (result !== "completed")
  throw new Error(`PART9_JOB_${result.toUpperCase()}`);
console.log("Part 9 bounded worker completed the selected synthetic job.");
