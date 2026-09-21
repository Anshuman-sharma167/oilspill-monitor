import { lstatSync, readFileSync, readlinkSync } from "node:fs";

import {
  addFinding,
  findSecrets,
  normalizePath,
  pathFindings,
} from "./repository-scan-rules.mjs";

export const scanCurrentFiles = (git, maxFileSizeBytes) => {
  const files = git([
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);
  const findings = [];

  for (const file of files) {
    const normalized = normalizePath(file);
    for (const rule of pathFindings(normalized)) {
      addFinding(findings, rule, normalized);
    }

    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    if (stat.size > maxFileSizeBytes) {
      addFinding(
        findings,
        {
          name: "privacy.file-over-safe-limit",
          remediation:
            "Remove the oversized file or store it in approved external storage; do not raise the limit without review.",
        },
        normalized,
      );
      continue;
    }

    const content = stat.isSymbolicLink()
      ? readlinkSync(file, "utf8")
      : readFileSync(file, "utf8");
    for (const rule of findSecrets(normalized, content)) {
      addFinding(findings, rule, normalized);
    }
  }

  return { filesChecked: files.length, findings };
};
