import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { platformCommand } from "../../scripts/platform-executable.mjs";

import { browserEnvironmentAllowlist } from "../../packages/config/src/browser.js";
import {
  requireServerConfig,
  serverOnlyEnvironmentNames,
} from "../../packages/config/src/server.js";

const root = resolve(".");
const read = (path: string) => readFileSync(resolve(path), "utf8");
const runNode = (
  script: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) =>
  spawnSync(process.execPath, [resolve(script), ...args], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
  });
const outputOf = (result: ReturnType<typeof spawnSync>) =>
  `${result.stdout ?? ""}${result.stderr ?? ""}`;
const expectedEnvironmentNames = [
  "CDSE_CLIENT_ID",
  "CDSE_CLIENT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "GITHUB_DISPATCH_TOKEN",
] as const;

test("npm executable selection is platform-specific without a shell", () => {
  assert.deepEqual(
    platformCommand("npm", ["--version"], {
      platform: "win32",
      npmExecPath: "C:\\node\\node_modules\\npm\\bin\\npm-cli.js",
      nodeExecPath: "C:\\node\\node.exe",
    }),
    {
      command: "C:\\node\\node.exe",
      args: ["C:\\node\\node_modules\\npm\\bin\\npm-cli.js", "--version"],
    },
  );
  assert.deepEqual(
    platformCommand("npm", ["ci"], {
      platform: "win32",
      npmExecPath: "",
    }),
    { command: "npm.cmd", args: ["ci"] },
  );
  assert.deepEqual(
    platformCommand("npm", ["--version"], { platform: "linux" }),
    { command: "npm", args: ["--version"] },
  );
  assert.deepEqual(
    platformCommand("node", ["--version"], { platform: "win32" }),
    { command: "node", args: ["--version"] },
  );
});

const withPart4Temp = <T>(
  prefix: string,
  action: (directory: string) => T,
): T => {
  const parent = resolve(".part4-tmp");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, prefix));
  try {
    return action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      rmSync(parent, { recursive: true, force: true });
    }
  }
};

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [relative(root, path)];
  });

test("Python version and dependency groups are consistent", () => {
  const version = read(".python-version").trim();
  const pyproject = read("pyproject.toml");
  const task = read("scripts/task.mjs");
  const workflow = read(".github/workflows/quality.yml");
  const documentation = read("docs/operations/reproducible-environments.md");

  assert.equal(version, "3.13.7");
  assert.match(pyproject, /requires-python = "==3\.13\.\*"/u);
  assert.match(pyproject, /^dependencies = \[\]$/mu);
  assert.match(pyproject, /^\[dependency-groups\]$/mu);
  assert.match(pyproject, /^dev = \[$/mu);
  assert.match(pyproject, /^training = \[\]$/mu);
  assert.match(pyproject, /required-version = "==0\.12\.18"/u);
  assert.match(task, new RegExp(`PYTHON_VERSION = "${version}"`, "u"));
  assert.match(workflow, /python-version-file: \.python-version/u);
  assert.match(workflow, /uv\.lock/u);
  assert.match(
    documentation,
    new RegExp(`Python ${version.replace(".", "\\.")}`, "u"),
  );
});

test("Node and npm versions are consistent everywhere", () => {
  const nodeVersion = read(".node-version").trim();
  const packageManifest = JSON.parse(read("package.json")) as {
    packageManager: string;
    engines: Record<string, string>;
  };
  const task = read("scripts/task.mjs");
  const workflow = read(".github/workflows/quality.yml");
  const dockerfile = read("services/worker/Dockerfile");

  assert.equal(read(".nvmrc").trim(), nodeVersion);
  assert.equal(packageManifest.engines.node, nodeVersion);
  assert.equal(packageManifest.engines.npm, "11.12.1");
  assert.equal(packageManifest.packageManager, "npm@11.12.1");
  assert.match(
    task,
    new RegExp(`NODE_VERSION = "${nodeVersion.replaceAll(".", "\\.")}"`, "u"),
  );
  assert.match(task, /NPM_VERSION = "11\.12\.1"/u);
  assert.match(
    workflow,
    new RegExp(`node-version: ${nodeVersion.replaceAll(".", "\\.")}`, "u"),
  );
  assert.match(
    dockerfile,
    new RegExp(
      `FROM node:${nodeVersion.replaceAll(".", "\\.")}-bookworm-slim`,
      "u",
    ),
  );
});

test("Node manifest and lockfile agree on exact direct dependencies and workspaces", () => {
  const manifest = JSON.parse(read("package.json")) as {
    devDependencies: Record<string, string>;
    engines: Record<string, string>;
  };
  const lock = JSON.parse(read("package-lock.json")) as {
    lockfileVersion: number;
    packages: Record<
      string,
      {
        devDependencies?: Record<string, string>;
        engines?: Record<string, string>;
        name?: string;
        resolved?: string;
      }
    >;
  };

  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(
    lock.packages[""]?.devDependencies,
    manifest.devDependencies,
  );
  assert.deepEqual(lock.packages[""]?.engines, manifest.engines);
  for (const [name, version] of Object.entries(manifest.devDependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, name);
  }
  for (const workspace of [
    "apps/dashboard",
    "packages/config",
    "packages/geo",
    "packages/schemas",
    "services/discovery",
    "services/worker",
  ]) {
    assert.ok(
      lock.packages[workspace],
      `missing lockfile workspace: ${workspace}`,
    );
  }
  assert.equal(
    lock.packages["packages/config"]?.name,
    "@oilspill-monitor/config",
  );
});

test("uv.lock is present, deterministic, hashed, and registry-only", () => {
  const lock = read("uv.lock");
  assert.match(lock, /^version = 1$/mu);
  assert.match(lock, /^revision = 3$/mu);
  assert.match(lock, /^requires-python = "==3\.13\.\*"$/mu);
  assert.match(lock, /name = "oilspill-monitor-environment"/u);
  assert.match(lock, /name = "bandit"[\s\S]*?version = "1\.9\.4"/u);
  assert.match(lock, /name = "sqlfluff"[\s\S]*?version = "4\.3\.0"/u);
  assert.match(lock, /hash = "sha256:[0-9a-f]{64}"/u);
  assert.doesNotMatch(lock, /source = \{ (?:git|url|path) =/u);
  for (const source of lock.matchAll(/source = \{ registry = "([^"]+)" \}/gu)) {
    assert.equal(source[1], "https://pypi.org/simple");
  }
});

test(".env.example has exactly the required blank names", () => {
  const example = read(".env.example");
  const assignments = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gmu)];
  assert.deepEqual(
    assignments.map((match) => match[1]),
    [...expectedEnvironmentNames],
  );
  for (const assignment of assignments) assert.equal(assignment[2], "");
});

test("browser allowlist is exact and server-only names stay out of browser code", () => {
  assert.deepEqual(browserEnvironmentAllowlist, [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
  ]);
  const browserSources = filesUnder(resolve("apps/dashboard"))
    .concat(["packages/config/src/browser.ts"])
    .map((path) => read(path))
    .join("\n");
  for (const name of serverOnlyEnvironmentNames) {
    assert.equal(browserSources.includes(name), false, name);
  }
  const result = runNode("scripts/check-config-boundary.mjs");
  assert.equal(result.status, 0, outputOf(result));
});

test("server configuration errors name missing variables without values", () => {
  const secretValue = ["sensitive", "-runtime-value-123456"].join("");
  assert.throws(
    () =>
      requireServerConfig(["CDSE_CLIENT_SECRET", "R2_SECRET_ACCESS_KEY"], {
        CDSE_CLIENT_SECRET: secretValue,
        R2_SECRET_ACCESS_KEY: "",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /R2_SECRET_ACCESS_KEY/u);
      assert.equal(error.message.includes(secretValue), false);
      return true;
    },
  );
});

test("explicit scan rejects and redacts a generated synthetic credential", () => {
  let fixture = "";
  withPart4Temp("secret-", (directory) => {
    fixture = join(directory, "positive-control.txt");
    const secretValue = ["synthetic", "-credential-value-", "123456789"].join(
      "",
    );
    writeFileSync(fixture, `MY_APP_CLIENT_SECRET=${secretValue}\n`);
    try {
      const ignored = spawnSync(
        "git",
        ["check-ignore", "-q", relative(root, fixture)],
        { cwd: root, encoding: "utf8", shell: false },
      );
      assert.equal(ignored.status, 0, outputOf(ignored));
      const tracked = spawnSync(
        "git",
        ["ls-files", "--error-unmatch", "--", relative(root, fixture)],
        { cwd: root, encoding: "utf8", shell: false },
      );
      assert.notEqual(tracked.status, 0);
      const result = runNode("scripts/scan-path.mjs", [
        relative(root, fixture),
      ]);
      assert.equal(result.status, 1);
      assert.match(outputOf(result), /secret\.hard-coded-credential/u);
      assert.equal(outputOf(result).includes(secretValue), false);
    } finally {
      rmSync(fixture, { force: true });
    }
    assert.equal(existsSync(fixture), false);
  });
  assert.equal(existsSync(fixture), false);
});

test("large-file positive control is rejected and cleaned", () => {
  let fixture = "";
  withPart4Temp("large-", (directory) => {
    fixture = join(directory, "oversized.txt");
    writeFileSync(fixture, "x".repeat(65));
    try {
      const result = runNode(
        "scripts/scan-path.mjs",
        [relative(root, fixture)],
        {
          env: {
            ...process.env,
            REPOSITORY_SCAN_MAX_FILE_SIZE_BYTES: "64",
          },
        },
      );
      assert.equal(result.status, 1);
      assert.match(outputOf(result), /privacy\.file-over-safe-limit/u);
    } finally {
      rmSync(fixture, { force: true });
    }
    assert.equal(existsSync(fixture), false);
  });
  assert.equal(existsSync(fixture), false);
});

test("temporary fixture helper cleans after a failing action", () => {
  let directory = "";
  assert.throws(
    () =>
      withPart4Temp("failure-", (created) => {
        directory = created;
        writeFileSync(join(created, "fixture.txt"), "temporary\n");
        throw new Error("intentional cleanup probe");
      }),
    /intentional cleanup probe/u,
  );
  assert.equal(existsSync(directory), false);
});

test("explicit scanning rejects traversal and symbolic links when supported", (t) => {
  const traversal = runNode("scripts/scan-path.mjs", ["../outside.txt"]);
  assert.notEqual(traversal.status, 0);
  assert.match(outputOf(traversal), /must stay within the repository/u);

  withPart4Temp("link-", (directory) => {
    const link = join(directory, "package-link.json");
    try {
      symlinkSync(resolve("package.json"), link, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
        t.diagnostic(`symbolic-link probe unsupported on this host: ${code}`);
        return;
      }
      throw error;
    }
    const result = runNode("scripts/scan-path.mjs", [relative(root, link)]);
    assert.notEqual(result.status, 0);
    assert.match(outputOf(result), /regular files, not links or directories/u);
  });
});

test("Python and SQL checks have valid no-file behavior", () => {
  for (const mode of [
    "python-format",
    "python-typecheck",
    "python-security",
    "sql-format",
  ]) {
    const result = runNode("scripts/file-check.mjs", [mode, "--paths"]);
    assert.equal(result.status, 0, outputOf(result));
    assert.match(outputOf(result), /SKIPPED: no (?:PY|SQL) files matched/u);
  }
});

test("required task commands are present and deferred commands are non-mutating", () => {
  const manifest = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  for (const command of [
    "setup",
    "check",
    "sample",
    "integration:mock",
    "dashboard",
    "db:reset",
    "db:migrate",
    "docs:build",
    "types:generate",
    "precommit",
    "audit:node",
    "audit:python",
    "verify:part4",
  ]) {
    assert.ok(manifest.scripts[command], command);
  }

  const before = [
    ...filesUnder(resolve("apps/dashboard")),
    ...filesUnder(resolve("supabase")),
  ].sort();
  for (const prerequisite of [
    "dashboard",
    "database-reset",
    "database-migration",
    "schema-type-generation",
  ]) {
    const result = runNode("scripts/task.mjs", ["deferred", prerequisite]);
    assert.equal(result.status, 2);
    assert.match(
      outputOf(result),
      new RegExp(
        `DEFERRED_PREREQUISITE: ${prerequisite} belongs to a later workflow part`,
        "u",
      ),
    );
  }
  const after = [
    ...filesUnder(resolve("apps/dashboard")),
    ...filesUnder(resolve("supabase")),
  ].sort();
  assert.deepEqual(after, before);
});

test("mock integration remains uncertain, review-required, and coordinate-free", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("scripts/mock-integration.ts"),
    ],
    { cwd: root, encoding: "utf8", shell: false },
  );
  assert.equal(result.status, 0, outputOf(result));
  const source = read("scripts/mock-integration.ts");
  assert.match(source, /assessment: "uncertain"/u);
  assert.match(source, /reviewStatus, "pending_manual_review"/u);
  assert.match(source, /coordinatesIncluded, false/u);
  assert.doesNotMatch(source, /latitude|longitude|geometry|coordinates:/iu);
});

test("container files enforce the static security boundary", () => {
  const result = runNode("scripts/validate-container.mjs");
  assert.equal(result.status, 0, outputOf(result));
  const dockerfile = read("services/worker/Dockerfile");
  const compose = read("compose.yaml");
  const dockerignore = read(".dockerignore");
  assert.equal((dockerfile.match(/^FROM /gmu) ?? []).length, 3);
  assert.match(dockerfile, /^USER node$/mu);
  assert.match(dockerfile, /npm ci --ignore-scripts/u);
  assert.match(
    dockerfile,
    /^COPY package\.json tsconfig\.json tsconfig\.container\.json \.\/$/mu,
  );
  assert.doesNotMatch(
    dockerfile,
    /^\s*(?:ARG|ENV)\s+.*(?:SECRET|TOKEN|KEY)/gimu,
  );
  assert.doesNotMatch(dockerfile, /^EXPOSE\s/gimu);
  assert.match(compose, /network_mode:\s*none/u);
  assert.match(compose, /read_only:\s*true/u);
  assert.match(compose, /cap_drop:\s*\r?\n\s*- ALL/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.match(compose, /restart: "no"/u);
  const ignoredPaths = dockerignore.split(/\r?\n/u);
  for (const ignored of [".git", ".env*", "data", "models", "tests"]) {
    assert.ok(ignoredPaths.includes(ignored), ignored);
  }
});

test("documentation generation is reproducible and does not copy values", () => {
  const directory = mkdtempSync(join(tmpdir(), "part4-docs-"));
  try {
    const secretValue = ["temporary", "-documentation-value-123456"].join("");
    mkdirSync(join(directory, "docs"));
    writeFileSync(join(directory, "README.md"), `# Test\n\n${secretValue}\n`);
    writeFileSync(join(directory, "docs", "guide.md"), "# Guide\n");
    const first = runNode("scripts/build-docs.mjs", [], { cwd: directory });
    assert.equal(first.status, 0, outputOf(first));
    const manifestPath = join(directory, "build", "docs", "manifest.json");
    const firstManifest = readFileSync(manifestPath, "utf8");
    const second = runNode("scripts/build-docs.mjs", [], { cwd: directory });
    assert.equal(second.status, 0, outputOf(second));
    const secondManifest = readFileSync(manifestPath, "utf8");
    assert.equal(secondManifest, firstManifest);
    assert.equal(secondManifest.includes(secretValue), false);
    assert.equal(outputOf(first).includes(secretValue), false);
    assert.equal(outputOf(second).includes(secretValue), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("local and CI quality checks share the same test entry point", () => {
  const manifest = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  const workflow = read(".github/workflows/quality.yml");
  assert.match(manifest.scripts["check:quality"] ?? "", /npm test/u);
  assert.match(manifest.scripts.check ?? "", /npm run check:quality/u);
  assert.match(workflow, /run: npm run check:quality/u);
  assert.equal(workflow.includes("npm test"), false);
});

test("CI actions, permissions, history handling, and commands are defensive", () => {
  for (const path of [
    ".github/workflows/quality.yml",
    ".github/workflows/secret-scan.yml",
  ]) {
    const workflow = read(path);
    for (const match of workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s#]+)/gmu)) {
      assert.match(match[1] ?? "", /^[0-9a-f]{40}$/u, path);
    }
    assert.match(workflow, /^permissions:\s*\r?\n\s+contents: read$/mu);
    assert.match(workflow, /cancel-in-progress: true/u);
    assert.match(workflow, /timeout-minutes: \d+/u);
    assert.doesNotMatch(workflow, /^\s*run:.*\$\{\{/gmu);
  }
  assert.match(read(".github/workflows/secret-scan.yml"), /fetch-depth: 0/u);
  const qualityWorkflow = read(".github/workflows/quality.yml");
  assert.match(
    qualityWorkflow,
    /npm install --global npm@11\.12\.1 --ignore-scripts/u,
  );
  assert.match(qualityWorkflow, /docker compose config/u);
  assert.match(qualityWorkflow, /docker compose build worker/u);
  assert.match(qualityWorkflow, /docker compose run --rm worker/u);
});

test("dependency sources and task execution avoid supply-chain hazards", () => {
  const lock = JSON.parse(read("package-lock.json")) as {
    packages: Record<string, { resolved?: string }>;
  };
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (
      metadata.resolved === undefined ||
      /^(?:apps|packages|services)\//u.test(metadata.resolved)
    ) {
      continue;
    }
    assert.match(metadata.resolved, /^https:\/\/registry\.npmjs\.org\//u, path);
  }
  const task = read("scripts/task.mjs");
  assert.match(task, /shell: false/u);
  assert.match(task, /npm", \["ci", "--ignore-scripts"\]/u);
  assert.match(read("services/worker/Dockerfile"), /npm ci --ignore-scripts/u);
  assert.match(task, /pip_audit"[\s\S]*"--local"[\s\S]*"--progress-spinner"/u);
});

test("repository security scan remains part of the canonical check", () => {
  const manifest = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  assert.match(manifest.scripts.check ?? "", /npm run scan:repo/u);
  assert.match(manifest.scripts["check:quality"] ?? "", /npm run sample/u);
  assert.match(
    manifest.scripts["check:quality"] ?? "",
    /npm run check:config/u,
  );
  assert.match(
    manifest.scripts["check:quality"] ?? "",
    /npm run check:container/u,
  );
});
test("generated environment directories are excluded from TypeScript linting", () => {
  const eslintConfig = read("eslint.config.mjs");
  for (const directory of [".venv", "build", ".part4-tmp"]) {
    assert.ok(eslintConfig.includes(`"${directory}/"`), directory);
  }
});
test("every quality workflow step has exactly one run or uses action", () => {
  const workflow = read(".github/workflows/quality.yml");
  const stepBlocks = workflow.split(/(?=^\s{6}- name:)/gmu).slice(1);

  assert.ok(stepBlocks.length > 0);

  for (const block of stepBlocks) {
    const name = block.match(/^\s{6}- name:\s*(.+)$/mu)?.[1] ?? "unnamed";
    const actions = [...block.matchAll(/^\s{8}(run|uses):/gmu)].map(
      (match) => match[1],
    );

    assert.equal(
      actions.length,
      1,
      `workflow step "${name}" must contain exactly one run or uses key`,
    );
  }
});
