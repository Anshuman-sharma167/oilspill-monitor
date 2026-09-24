import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const python =
  process.platform === "win32"
    ? join(".venv", "Scripts", "python.exe")
    : join(".venv", "bin", "python");

const gitFiles = (extension) => {
  const result = spawnSync(
    "git",
    [
      "-c",
      `safe.directory=${process.cwd().replaceAll("\\", "/")}`,
      "ls-files",
      "-z",
      "--",
      `*.${extension}`,
    ],
    { encoding: "utf8", shell: false },
  );
  if (result.status !== 0)
    throw new Error("Unable to enumerate tracked files.");
  return result.stdout.split("\0").filter(Boolean);
};

const mode = process.argv[2];
const pathsIndex = process.argv.indexOf("--paths");
const extension = mode === "sql-format" ? "sql" : "py";
const files =
  pathsIndex === -1
    ? gitFiles(extension)
    : process.argv
        .slice(pathsIndex + 1)
        .filter((path) => path.endsWith(`.${extension}`));

if (files.length === 0) {
  console.log(`SKIPPED: no ${extension.toUpperCase()} files matched.`);
  process.exit(0);
}
if (!existsSync(python)) {
  throw new Error(
    "Python environment is missing. Run npm run setup:python first.",
  );
}

const commands = {
  "python-format": ["black", "--check", "--", ...files],
  "python-typecheck": ["mypy", "--", ...files],
  "python-security": ["bandit", "-q", "--", ...files],
  "sql-format": ["sqlfluff", "lint", "--dialect", "postgres", ...files],
};
const selected = commands[mode];
if (selected === undefined)
  throw new Error(`Unsupported file-check mode: ${mode}`);

const result = spawnSync(python, ["-m", ...selected], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: false,
});
if (result.error !== undefined) throw result.error;
process.exitCode = result.status ?? 1;
