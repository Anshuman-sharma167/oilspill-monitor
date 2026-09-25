import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { platformCommand } from "./platform-executable.mjs";

const PYTHON_VERSION = "3.13.7";
const NODE_VERSION = "24.15.0";
const NPM_VERSION = "11.12.1";
const UV_VERSION = "0.12.18";

const run = (command, args, options = {}) => {
  const selected = platformCommand(command, args);
  const result = spawnSync(selected.command, selected.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const capture = (command, args) => {
  const selected = platformCommand(command, args);
  const result = spawnSync(selected.command, selected.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`Unable to run required executable: ${selected.command}`);
  }
  return result.stdout.trim();
};

const venvPython = () =>
  process.platform === "win32"
    ? join(".venv", "Scripts", "python.exe")
    : join(".venv", "bin", "python");

const basePython = () =>
  process.platform === "win32"
    ? { command: "py", args: ["-3.13"] }
    : { command: "python3", args: [] };

const assertVersions = () => {
  const actualNode = process.version.replace(/^v/u, "");
  if (actualNode !== NODE_VERSION) {
    throw new Error(
      `Node.js ${NODE_VERSION} is required; found ${actualNode}.`,
    );
  }
  const actualNpm = capture("npm", ["--version"]);
  if (actualNpm !== NPM_VERSION) {
    throw new Error(`npm ${NPM_VERSION} is required; found ${actualNpm}.`);
  }
};

const setupPython = () => {
  const base = basePython();
  const actual = capture(base.command, [
    ...base.args,
    "-c",
    "import sys; print('.'.join(map(str, sys.version_info[:3])))",
  ]);
  if (actual !== PYTHON_VERSION) {
    throw new Error(`Python ${PYTHON_VERSION} is required; found ${actual}.`);
  }
  if (!existsSync(venvPython())) {
    run(base.command, [...base.args, "-m", "venv", ".venv"]);
  }
  run(venvPython(), [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-input",
    "--only-binary=:all:",
    `uv==${UV_VERSION}`,
  ]);
  run(venvPython(), [
    "-m",
    "uv",
    "sync",
    "--locked",
    "--group",
    "dev",
    "--no-group",
    "training",
    "--no-progress",
  ]);
};

const command = process.argv[2];

if (command === "versions") {
  assertVersions();
  console.log("Pinned Node.js and npm versions are active.");
} else if (command === "setup") {
  assertVersions();
  run("npm", ["ci", "--ignore-scripts"]);
  setupPython();
  console.log("Setup complete from locked Node and Python dependencies.");
} else if (command === "setup-python") {
  setupPython();
} else if (command === "precommit") {
  run(venvPython(), ["-m", "pre_commit", "run", "--all-files"]);
} else if (command === "audit-python") {
  run(venvPython(), [
    "-m",
    "pip_audit",
    "--local",
    "--progress-spinner",
    "off",
  ]);
} else if (command === "deferred") {
  const prerequisite = process.argv[3] ?? "unknown";
  console.error(
    `DEFERRED_PREREQUISITE: ${prerequisite} belongs to a later workflow part; Part 4 does not implement it.`,
  );
  process.exitCode = 2;
} else {
  console.error(
    "Usage: node scripts/task.mjs <versions|setup|setup-python|precommit|audit-python|deferred>",
  );
  process.exitCode = 2;
}
