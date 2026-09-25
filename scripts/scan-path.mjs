import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  configuredSafeLimit,
  findSecrets,
  normalizePath,
  pathFindings,
} from "./repository-scan-rules.mjs";

const root = resolve(process.cwd());
const maxFileSizeBytes = configuredSafeLimit();
const requestedPaths = process.argv.slice(2);
if (requestedPaths.length === 0) {
  console.error(
    "Usage: node scripts/scan-path.mjs <repository-local-file> [...]",
  );
  process.exit(2);
}

let failed = false;
for (const requestedPath of requestedPaths) {
  const absolute = resolve(root, requestedPath);
  const withinRoot = relative(root, absolute);
  if (isAbsolute(withinRoot) || withinRoot.startsWith("..")) {
    throw new Error("Scan paths must stay within the repository.");
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      "Scan paths must be regular files, not links or directories.",
    );
  }
  const normalized = normalizePath(withinRoot);
  const findings = [...pathFindings(normalized)];
  if (stat.size > maxFileSizeBytes) {
    findings.push({
      name: "privacy.file-over-safe-limit",
      remediation: "Remove the oversized temporary fixture.",
    });
  } else {
    findings.push(...findSecrets(normalized, readFileSync(absolute, "utf8")));
  }
  for (const finding of findings) {
    failed = true;
    console.error(`Rule: ${finding.name}`);
    console.error(`Path: ${normalized}`);
    console.error(`Remediation: ${finding.remediation}`);
    console.error("");
  }
}

if (failed) process.exitCode = 1;
else
  console.log(
    `Explicit path scan passed (${requestedPaths.length} file(s) checked).`,
  );
