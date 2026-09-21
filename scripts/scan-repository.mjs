import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const safeDirectory = process.cwd().replaceAll("\\", "/");

const files = execFileSync(
  "git",
  [
    "-c",
    `safe.directory=${safeDirectory}`,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ],
  { encoding: "utf8" },
)
  .split(/\r?\n/u)
  .filter(Boolean);

const forbiddenExtensions = new Set([
  ".tif",
  ".tiff",
  ".geotiff",
  ".img",
  ".vrt",
  ".jp2",
  ".nc",
  ".h5",
  ".hdf5",
  ".zip",
  ".7z",
  ".rar",
  ".tar",
  ".gz",
  ".npz",
  ".npy",
  ".onnx",
  ".pt",
  ".pth",
  ".ckpt",
  ".safetensors",
  ".bin",
  ".db",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".sqlite",
  ".sqlite3",
  ".duckdb",
]);
const forbiddenPaths = [
  /(^|\/)\.env(?:\.|$)/u,
  /\.safe(?:\/|$)/iu,
  /(^|\/)(?:private|evidence|exports|generated|outputs)(?:\/|$)/iu,
  /(?:coordinate|coords|candidate.*export|reviewer.*export|review.*evidence)/iu,
];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
  /X-Amz-Signature=[A-Fa-f0-9]{16,}/u,
];

const findings = [];
for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  if (forbiddenExtensions.has(extname(normalized).toLowerCase())) {
    findings.push(`${file}: forbidden private-data or model extension`);
  }
  if (forbiddenPaths.some((pattern) => pattern.test(normalized))) {
    findings.push(`${file}: forbidden private-data path`);
  }

  const stat = statSync(file);
  if (stat.size > 5 * 1024 * 1024) {
    findings.push(`${file}: unexpectedly large file (${stat.size} bytes)`);
    continue;
  }

  const content = readFileSync(file, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) {
    findings.push(`${file}: likely secret material`);
  }
}

if (findings.length > 0) {
  console.error("Repository scan failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Repository scan passed (${files.length} files checked).`);
}
