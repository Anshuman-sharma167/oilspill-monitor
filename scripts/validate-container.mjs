import { readFileSync } from "node:fs";

const dockerfile = readFileSync("services/worker/Dockerfile", "utf8");
const compose = readFileSync("compose.yaml", "utf8");
const dockerignore = readFileSync(".dockerignore", "utf8");

const requirements = [
  [
    dockerfile,
    /^FROM node:24\.15\.0-bookworm-slim AS dependencies$/mu,
    "exact dependency base",
  ],
  [
    dockerfile,
    /^FROM node:24\.15\.0-bookworm-slim AS builder$/mu,
    "exact builder base",
  ],
  [
    dockerfile,
    /^FROM node:24\.15\.0-bookworm-slim AS runtime$/mu,
    "exact runtime base",
  ],
  [dockerfile, /^USER node$/mu, "non-root runtime user"],
  [dockerfile, /^HEALTHCHECK NONE$/mu, "explicit one-shot healthcheck policy"],
  [compose, /network_mode:\s*none/u, "disabled integration network"],
  [compose, /read_only:\s*true/u, "read-only integration filesystem"],
  [compose, /cap_drop:\s*\r?\n\s*- ALL/u, "dropped Linux capabilities"],
  [compose, /no-new-privileges:true/u, "no-new-privileges"],
  [dockerignore, /^\.env\*$/mu, "environment-file build-context exclusion"],
  [dockerignore, /^\.git$/mu, "Git metadata build-context exclusion"],
];

const missing = requirements
  .filter(([content, pattern]) => !pattern.test(content))
  .map(([, , label]) => label);
if (/^\s*(?:ARG|ENV)\s+.*(?:SECRET|TOKEN|KEY)/imu.test(dockerfile)) {
  missing.push("no credential-shaped build arguments or environment metadata");
}
if (/^\s*EXPOSE\s+/imu.test(dockerfile)) missing.push("no exposed ports");

if (missing.length > 0) {
  console.error(`Container validation failed: ${missing.join(", ")}.`);
  process.exitCode = 1;
} else {
  console.log("Container configuration static validation passed.");
}
