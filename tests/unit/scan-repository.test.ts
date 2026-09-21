import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const scanner = resolve("scripts/scan-repository.mjs");
const git = (repository: string, args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" });

const createRepository = () => {
  const repository = mkdtempSync(join(tmpdir(), "repository-scan-test-"));
  git(repository, ["init", "--quiet"]);
  return repository;
};

const commitAll = (repository: string, message: string) => {
  git(repository, ["add", "--all"]);
  git(repository, [
    "-c",
    "user.name=Repository Scan Test",
    "-c",
    "user.email=repository-scan@example.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
};

const runScanner = (
  repository: string,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  spawnSync(process.execPath, [scanner], {
    cwd: repository,
    encoding: "utf8",
    env: environment,
  });

test("detects every supported secret category without printing secret values", () => {
  const repository = createRepository();
  try {
    writeFileSync(repository + "/README.md", "synthetic repository\n");
    commitAll(repository, "initial safe file");
    const syntheticSecrets = [
      ["-----BE", "GIN OPENSSH PRIVATE KEY-----"].join(""),
      ["AK", "IA", "1A2B3C4D5E6F7G8H"].join(""),
      ["AS", "IA", "1A2B3C4D5E6F7G8H"].join(""),
      ["gh", "p_", "A".repeat(36)].join(""),
      ["github", "_pat_", "A".repeat(60)].join(""),
      ["xox", "b-", "1234567890-ABCDEFGHIJ"].join(""),
      [
        "eyJ",
        "hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.",
        "S".repeat(24),
      ].join(""),
      ["AI", "za", "A".repeat(35)].join(""),
      ["s", "k_live_", "A".repeat(24)].join(""),
      [
        "https://bucket.s3.amazonaws.com/item?X-Amz-Signature=",
        "a".repeat(32),
      ].join(""),
      [
        "https://storage.googleapis.com/bucket/item?X-Goog-Signature=",
        "A".repeat(32),
      ].join(""),
      ["client_", 'secret = "', "value-with-high-entropy-123", '"'].join(""),
    ];
    writeFileSync(repository + "/untracked.txt", syntheticSecrets.join("\n"));

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    for (const rule of [
      "secret.private-key-header",
      "secret.aws-access-key-id",
      "secret.github-legacy-token",
      "secret.github-fine-grained-token",
      "secret.slack-token",
      "secret.jwt",
      "secret.google-api-key",
      "secret.live-payment-provider-key",
      "secret.aws-signed-storage-url",
      "secret.google-signed-storage-url",
      "secret.hard-coded-credential",
    ]) {
      assert.match(result.stderr, new RegExp(`Rule: ${rule}`, "u"));
    }
    for (const secret of syntheticSecrets) {
      assert.equal(result.stderr.includes(secret), false);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("detects standalone AWS signatures without requiring a complete URL", () => {
  const repository = createRepository();
  try {
    writeFileSync(repository + "/README.md", "synthetic repository\n");
    commitAll(repository, "initial safe file");

    const signature = "b".repeat(64);
    const cases = new Map([
      ["presigned-post.txt", ["X-Amz-", `Signature=${signature}`].join("")],
      [
        "presigned-post.json",
        ['{"X-Amz-', `Signature":"${signature}"}`].join(""),
      ],
      ["wrapped-fragment.txt", ["&X-Amz-", `Signature=${signature}`].join("")],
    ]);
    for (const [path, content] of cases) {
      writeFileSync(join(repository, path), content + "\n");
    }

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    for (const path of cases.keys()) {
      assert.match(
        result.stderr,
        new RegExp(
          `Rule: secret\\.aws-signed-storage-url\\r?\\nPath: ${path.replaceAll(".", "\\.")}`,
          "u",
        ),
      );
    }
    assert.equal(result.stderr.includes(signature), false);
    assert.equal(result.stdout.includes(signature), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("detects common credential assignments with bounded values", () => {
  const repository = createRepository();
  try {
    writeFileSync(repository + "/README.md", "synthetic repository\n");
    commitAll(repository, "initial safe file");

    const credentialValue = ["real", "-value-123456"].join("");
    const cases = new Map([
      ["json.txt", `{"client_secret":"${credentialValue}"}`],
      ["dotenv.txt", `CLIENT_SECRET=${credentialValue}`],
      ["yaml.txt", `api-key: ${credentialValue}`],
      ["quoted.txt", `password = '${credentialValue}'`],
      ["comma.txt", `api_key=${credentialValue}, NEXT=safe`],
      ["brace.txt", `{"password":${credentialValue}}`],
      ["semicolon.txt", `password=${credentialValue}; NEXT=safe`],
      ["hash-comment.txt", `password=${credentialValue}#comment`],
      ["slash-comment.txt", `password=${credentialValue}//comment`],
    ]);
    for (const [path, assignment] of cases) {
      writeFileSync(join(repository, path), assignment + "\n");
    }

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    for (const path of cases.keys()) {
      assert.match(result.stderr, new RegExp(`Path: ${path}`, "u"));
    }
    assert.match(result.stderr, /Rule: secret\.hard-coded-credential/u);
    assert.equal(result.stderr.includes(credentialValue), false);
    assert.equal(result.stdout.includes(credentialValue), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("detects namespaced credential keys in current files without printing values", () => {
  const repository = createRepository();
  try {
    writeFileSync(repository + "/README.md", "synthetic repository\n");
    commitAll(repository, "initial safe file");

    const credentialValue = ["real", "-value-123456"].join("");
    const cases = new Map([
      ["dotenv.txt", `OPENAI_API_KEY=${credentialValue}`],
      ["yaml.txt", `DATABASE_PASSWORD: ${credentialValue}`],
      ["quoted.txt", `MY_APP_CLIENT_SECRET = "${credentialValue}"`],
      ["json.txt", `{"PAYMENT_SERVICE_AUTH_TOKEN":"${credentialValue}"}`],
      ["hyphen.txt", `service-bearer-token=${credentialValue}`],
    ]);
    for (const [path, assignment] of cases) {
      writeFileSync(join(repository, path), assignment + "\n");
    }

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    for (const path of cases.keys()) {
      assert.match(result.stderr, new RegExp(`Path: ${path}`, "u"));
    }
    assert.match(result.stderr, /Rule: secret\.hard-coded-credential/u);
    assert.equal(result.stderr.includes(credentialValue), false);
    assert.equal(result.stdout.includes(credentialValue), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("detects namespaced credential keys in history-only blobs", () => {
  const repository = createRepository();
  try {
    const credentialValue = ["history", "-value-123456"].join("");
    const path = "namespaced-history.txt";
    writeFileSync(
      join(repository, path),
      `PAYMENT_SERVICE_ACCESS_TOKEN=${credentialValue}\n`,
    );
    commitAll(repository, "add namespaced historical credential");
    const containingCommit = git(repository, ["rev-parse", "HEAD"]).trim();
    rmSync(join(repository, path));
    commitAll(repository, "remove namespaced historical credential");
    const removalCommit = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Rule: secret\.hard-coded-credential/u);
    assert.match(result.stderr, /Path: namespaced-history\.txt/u);
    assert.match(result.stderr, new RegExp(`Commit: ${containingCommit}`, "u"));
    assert.doesNotMatch(
      result.stderr,
      new RegExp(`Commit: ${removalCommit}`, "u"),
    );
    assert.match(result.stderr, /Object: [0-9a-f]{40}/u);
    assert.equal(result.stderr.includes(credentialValue), false);
    assert.equal(result.stdout.includes(credentialValue), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
test("attributes replaced historical blobs to a commit whose tree contains them", () => {
  const repository = createRepository();
  try {
    const credentialValue = ["history", "-value-123456"].join("");
    const path = "replaced-history.txt";
    writeFileSync(join(repository, path), `client_secret=${credentialValue}\n`);
    commitAll(repository, "add historical credential");
    const containingCommit = git(repository, ["rev-parse", "HEAD"]).trim();

    writeFileSync(join(repository, path), "SAFE_SETTING=true\n");
    commitAll(repository, "replace historical credential");
    const replacementCommit = git(repository, ["rev-parse", "HEAD"]).trim();

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      new RegExp(
        `Path: replaced-history\\.txt\\r?\\nCommit: ${containingCommit}`,
        "u",
      ),
    );
    assert.doesNotMatch(
      result.stderr,
      new RegExp(
        `Path: replaced-history\\.txt\\r?\\nCommit: ${replacementCommit}`,
        "u",
      ),
    );
    assert.equal(result.stderr.includes(credentialValue), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
test("uses bounded history traversal and retains paths across branches and renames", () => {
  const repository = createRepository();
  try {
    const primaryBranch = git(repository, ["branch", "--show-current"]).trim();
    const credentialValue = ["history", "-value-123456"].join("");
    const originalPath = "original config.txt";
    const renamedPath = "renamed ü config.txt";

    writeFileSync(
      join(repository, originalPath),
      `client_secret=${credentialValue}\n`,
    );
    commitAll(repository, "root secret");
    git(repository, ["tag", "historical-root"]);
    git(repository, ["branch", "feature/history"]);

    renameSync(join(repository, originalPath), join(repository, renamedPath));
    commitAll(repository, "rename secret");
    rmSync(join(repository, renamedPath));
    commitAll(repository, "delete renamed secret");

    git(repository, ["checkout", "--quiet", "feature/history"]);
    writeFileSync(repository + "/.env.branch", "SAFE_SETTING=true\n");
    commitAll(repository, "branch prohibited path");
    git(repository, ["checkout", "--quiet", primaryBranch]);
    git(repository, [
      "-c",
      "user.name=Repository Scan Test",
      "-c",
      "user.email=repository-scan@example.invalid",
      "merge",
      "--quiet",
      "--no-ff",
      "feature/history",
      "-m",
      "merge feature history",
    ]);
    rmSync(repository + "/.env.branch");
    commitAll(repository, "delete branch path");

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    const originalObject =
      /Path: original config\.txt\r?\nCommit: [0-9a-f]{40}\r?\nObject: ([0-9a-f]{40})/u.exec(
        result.stderr,
      )?.[1];
    const renamedObject =
      /Path: renamed . config\.txt\r?\nCommit: [0-9a-f]{40}\r?\nObject: ([0-9a-f]{40})/u.exec(
        result.stderr,
      )?.[1];
    assert.notEqual(originalObject, undefined);
    assert.equal(renamedObject, originalObject);
    assert.match(result.stderr, /Path: \.env\.branch/u);
    assert.match(result.stderr, /Rule: privacy\.prohibited-path/u);
    assert.match(result.stderr, /Commit: [0-9a-f]{40}/u);
    assert.match(result.stderr, /Object: [0-9a-f]{40}/u);
    assert.equal(result.stderr.includes(credentialValue), false);

    const historySource = readFileSync(
      resolve("scripts/repository-scan-history.mjs"),
      "utf8",
    );
    assert.doesNotMatch(historySource, /ls-tree/u);
    assert.match(historySource, /HISTORY_INVENTORY_GIT_PROCESS_COUNT = 3/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
test("scans tracked, untracked, and history-only files for privacy rules", () => {
  const repository = createRepository();
  try {
    writeFileSync(repository + "/.env.history", "SAFE_SETTING=true\n");
    commitAll(repository, "add historical prohibited path");
    rmSync(repository + "/.env.history");
    writeFileSync(repository + "/tracked.txt", "safe tracked text\n");
    commitAll(repository, "replace historical file");
    writeFileSync(repository + "/untracked.bin", "small binary fixture\n");
    writeFileSync(repository + "/large.txt", "x".repeat(128));

    const result = runScanner(repository, {
      ...process.env,
      REPOSITORY_SCAN_MAX_FILE_SIZE_BYTES: "64",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Path: \.env\.history/u);
    assert.match(result.stderr, /Commit: [0-9a-f]{40}/u);
    assert.match(result.stderr, /Object: [0-9a-f]{40}/u);
    assert.match(result.stderr, /Path: untracked\.bin/u);
    assert.match(result.stderr, /Rule: privacy\.prohibited-extension/u);
    assert.match(result.stderr, /Path: large\.txt/u);
    assert.match(result.stderr, /Rule: privacy\.file-over-safe-limit/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("accepts safe examples and placeholder-based configuration", () => {
  const repository = createRepository();
  try {
    const safeLiteral = ["real", "-value-123456"].join("");
    const safeExamples = [
      "password = process.env.PASSWORD",
      ["CLIENT_", "SECRET=$CLIENT_SECRET"].join(""),
      "api-key=${API_KEY}",
      ["pass", "word=%PASSWORD%"].join(""),
      'client_secret = "{{ secrets.CLIENT_SECRET }}"',
      'api_key = "placeholder"',
      "password = dummy-value-123456",
      ["client_", "secret = [REDACTED]"].join(""),
      "api_key = short",
      "token prefix: AKI (incomplete)",
      "unsigned URL: https://storage.googleapis.com/public/example.txt",
      [`PASSWORD`, `_HASH=${safeLiteral}`].join(""),
      [`PASSWORD`, `_RESET_REQUIRED=${safeLiteral}`].join(""),
      [`API_KEY`, `_NAME=${safeLiteral}`].join(""),
      [`API_KEY`, `_DESCRIPTION=${safeLiteral}`].join(""),
      [`MON`, `KEY=${safeLiteral}`].join(""),
      [`KEY`, `NOTE=${safeLiteral}`].join(""),
    ];
    writeFileSync(repository + "/safe.ts", safeExamples.join("\n"));
    commitAll(repository, "safe examples");

    const result = runScanner(repository);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Repository scan passed/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("accepts structured runtime credential references only in source files", () => {
  const repository = createRepository();
  try {
    const runtimeAssignments = new Map([
      ["request.ts", ["pass", "word = req.body.password"].join("")],
      ["config.ts", ["api", "Key = config.apiKey"].join("")],
      ["optional.ts", ["pass", "word = request.body?.password"].join("")],
      ["double-bracket.ts", ["api", 'Key = settings["apiKey"]'].join("")],
      ["single-bracket.ts", ["pass", "word = payload['password']"].join("")],
      ["function.ts", ["api", "Key = getRuntimeConfig().apiKey"].join("")],
      [
        "awaited.ts",
        ["pass", 'word = await secretStore.read("password")'].join(""),
      ],
      ["bare.ts", ["pass", "word = runtimePassword"].join("")],
      ["openai.ts", ["OPENAI_", "API_", "KEY = config.openaiApiKey"].join("")],
      [
        "database.ts",
        ["DATABASE_", "PASS", "WORD = req.body.password"].join(""),
      ],
      [
        "app-secret.ts",
        [
          "MY_APP_",
          "CLIENT_",
          'SECRET = await secretStore.read("clientSecret")',
        ].join(""),
      ],
    ]);
    for (const [path, assignment] of runtimeAssignments) {
      writeFileSync(join(repository, path), assignment + "\n");
    }
    commitAll(repository, "source runtime references");

    const result = runScanner(repository);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Repository scan passed/u);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("keeps runtime-looking values conservative in configuration files", () => {
  const repository = createRepository();
  try {
    writeFileSync(repository + "/README.md", "synthetic repository\n");
    commitAll(repository, "initial safe file");
    const runtimeLookingValue = ["req", ".body.password"].join("");
    const cases = new Map([
      [".env.runtime", `PASSWORD=${runtimeLookingValue}`],
      ["settings.yaml", `password: ${runtimeLookingValue}`],
      ["settings.toml", `password = ${runtimeLookingValue}`],
      ["settings.ini", `password = ${runtimeLookingValue}`],
      ["settings.properties", `password=${runtimeLookingValue}`],
      ["namespaced.env", `OPENAI_API_KEY=${runtimeLookingValue}`],
      ["namespaced.yaml", `DATABASE_PASSWORD: ${runtimeLookingValue}`],
      ["namespaced.json", `{"MY_APP_CLIENT_SECRET":"${runtimeLookingValue}"}`],
    ]);
    for (const [path, assignment] of cases) {
      writeFileSync(join(repository, path), assignment + "\n");
    }

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    for (const path of cases.keys()) {
      assert.match(
        result.stderr,
        new RegExp(
          `Rule: secret\\.hard-coded-credential\\r?\\nPath: ${path.replaceAll(".", "\\.")}`,
          "u",
        ),
      );
    }
    assert.equal(result.stderr.includes(runtimeLookingValue), false);
    assert.equal(result.stdout.includes(runtimeLookingValue), false);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("detects quoted runtime text and non-expression dotted values in source", () => {
  const repository = createRepository();
  try {
    writeFileSync(repository + "/README.md", "synthetic repository\n");
    commitAll(repository, "initial safe file");
    const cases = new Map([
      ["quoted.ts", ["pass", 'word = "req.body.password"'].join("")],
      ["dotted.ts", ["api", "Key = segment123.segment456.segment789"].join("")],
      [
        "url.ts",
        ["api", "Key = https://example.invalid/runtime-token-123456"].join(""),
      ],
    ]);
    for (const [path, assignment] of cases) {
      writeFileSync(join(repository, path), assignment + "\n");
    }

    const result = runScanner(repository);
    assert.equal(result.status, 1);
    for (const path of cases.keys()) {
      assert.match(
        result.stderr,
        new RegExp(
          `Rule: secret\\.hard-coded-credential\\r?\\nPath: ${path.replaceAll(".", "\\.")}`,
          "u",
        ),
      );
    }
    for (const assignment of cases.values()) {
      const value = assignment.slice(assignment.indexOf("=") + 1).trim();
      assert.equal(result.stderr.includes(value), false);
      assert.equal(result.stdout.includes(value), false);
    }
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});
