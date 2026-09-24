import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dashboardRoot = join("apps", "dashboard");
const prohibitedNames = [
  "CDSE_CLIENT_ID",
  "CDSE_CLIENT_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "GITHUB_DISPATCH_TOKEN",
];
const prohibitedPatterns = [
  /packages\/config\/src\/server/iu,
  /@oilspill-monitor\/config\/server/iu,
  /\b(?:NEXT_PUBLIC|VITE|PUBLIC)_[A-Z0-9_]*(?:SECRET|TOKEN|SERVICE_ROLE|ACCESS_KEY)/u,
];

const filesUnder = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });

const findings = [];
for (const path of filesUnder(dashboardRoot)) {
  if (!statSync(path).isFile()) continue;
  const content = readFileSync(path, "utf8");
  for (const name of prohibitedNames) {
    if (content.includes(name))
      findings.push(`${path}: server-only name ${name}`);
  }
  for (const pattern of prohibitedPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(content))
      findings.push(`${path}: prohibited browser configuration pattern`);
  }
}

if (findings.length > 0) {
  console.error("Browser/server configuration boundary failed.");
  for (const finding of findings) console.error(finding);
  process.exitCode = 1;
} else {
  console.log("Browser/server configuration boundary passed.");
}
