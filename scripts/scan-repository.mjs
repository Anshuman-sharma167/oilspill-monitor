import { execFileSync } from "node:child_process";

import { scanCurrentFiles } from "./repository-scan-current.mjs";
import { scanHistory } from "./repository-scan-history.mjs";
import { configuredSafeLimit } from "./repository-scan-rules.mjs";

const safeDirectory = process.cwd().replaceAll("\\", "/");
const git = (args) =>
  execFileSync("git", ["-c", `safe.directory=${safeDirectory}`, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

const printFinding = (finding) => {
  console.error(`Rule: ${finding.rule}`);
  console.error(`Path: ${finding.path}`);
  if (finding.commit !== undefined) console.error(`Commit: ${finding.commit}`);
  if (finding.object !== undefined) console.error(`Object: ${finding.object}`);
  console.error(`Remediation: ${finding.remediation}`);
  console.error("");
};

const maxFileSizeBytes = configuredSafeLimit();
const current = scanCurrentFiles(git, maxFileSizeBytes);
const history = scanHistory(git, safeDirectory, maxFileSizeBytes);
const findings = [...current.findings, ...history.findings];

if (findings.length > 0) {
  console.error("Repository scan failed.");
  for (const finding of findings) printFinding(finding);
  process.exitCode = 1;
} else {
  console.log(
    `Repository scan passed (${current.filesChecked} current files and ${history.blobsChecked} reachable committed blobs checked).`,
  );
}
