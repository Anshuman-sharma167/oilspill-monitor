import { extname } from "node:path";

export const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

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

const makePattern = (fragments, flags = "u") =>
  new RegExp(fragments.join(""), flags);

const sourceCodeExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".cts",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
]);

const isSourceCodePath = (path) =>
  sourceCodeExtensions.has(extname(path).toLowerCase());

const explicitPlaceholder = (candidate) =>
  /^(?:changeme|change-me|example|placeholder|test|dummy|redacted|not[-_]?set|todo)(?:$|[-_.])/iu.test(
    candidate,
  ) ||
  /^(?:\*+|x{4,}|\[?redacted\]?)$/iu.test(candidate) ||
  /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[^}]+\}?|%[A-Z_][A-Z0-9_]*%)$/iu.test(
    candidate,
  ) ||
  /^(?:\{\{[\s\S]+\}\}|<%[\s\S]+%>|#\{[\s\S]+\})$/u.test(candidate) ||
  /^<[^>]+>$/u.test(candidate);

const runtimeIdentifier = "[A-Za-z_$][A-Za-z0-9_$]*";
const runtimeLookupKey =
  "(?:\"[A-Za-z_$][A-Za-z0-9_$-]*\"|'[A-Za-z_$][A-Za-z0-9_$-]*')";
const runtimeCall = `\\(\\s*(?:${runtimeLookupKey})?\\s*\\)`;
const runtimeAccess = `(?:\\.|\\?\\.)${runtimeIdentifier}|(?:\\?\\.)?\\[\\s*${runtimeLookupKey}\\s*\\]`;
const structuredRuntimeExpression = new RegExp(
  `^(?:await\\s+)?${runtimeIdentifier}(?:${runtimeCall})?(?:(?:${runtimeAccess})(?:${runtimeCall})?)+$`,
  "u",
);
const bareRuntimeIdentifier = new RegExp(`^${runtimeIdentifier}$`, "u");
const credentialReferenceNames = new Set([
  "password",
  "passwd",
  "pwd",
  "apikey",
  "clientsecret",
  "accesstoken",
  "authtoken",
  "bearertoken",
]);

const credentialName =
  "(?:password|passwd|pwd|api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|bearer[_-]?token)";
const credentialNamespace = "(?:[A-Za-z0-9]+[_-])+";
const credentialKey = `(?:${credentialNamespace})?${credentialName}`;
const separatedCredentialReference = new RegExp(
  `(?:^|[_-])${credentialName}$`,
  "iu",
);
const camelCaseCredentialReference =
  /(?:Password|Passwd|Pwd|ApiKey|ClientSecret|AccessToken|AuthToken|BearerToken)$/u;
const isStructuredRuntimeExpression = (candidate) => {
  if (bareRuntimeIdentifier.test(candidate)) return true;
  if (!structuredRuntimeExpression.test(candidate)) return false;
  const referencedNames = candidate.match(/[A-Za-z_$][A-Za-z0-9_$-]*/gu) ?? [];
  return referencedNames.some(
    (name) =>
      credentialReferenceNames.has(
        name.replaceAll(/[-_]/gu, "").toLowerCase(),
      ) ||
      separatedCredentialReference.test(name) ||
      camelCaseCredentialReference.test(name),
  );
};

const secretRules = [
  {
    name: "secret.private-key-header",
    pattern: makePattern([
      "-----BE",
      "GIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----",
    ]),
    remediation:
      "Remove the private key, rotate it, and load the replacement from an approved secret store.",
  },
  {
    name: "secret.aws-access-key-id",
    pattern: makePattern(["\\b(?:AK", "IA|AS", "IA)[0-9A-Z]{16}\\b"]),
    remediation:
      "Revoke and rotate the AWS credential, then use an injected credential or workload identity.",
  },
  {
    name: "secret.github-legacy-token",
    pattern: makePattern(["\\bgh", "[pousr]_[A-Za-z0-9]{36,255}\\b"]),
    remediation:
      "Revoke the GitHub token and replace it with a least-privilege injected credential.",
  },
  {
    name: "secret.github-fine-grained-token",
    pattern: makePattern(["\\bgithub", "_pat_[A-Za-z0-9_]{20,255}\\b"]),
    remediation:
      "Revoke the fine-grained GitHub token and replace it with a least-privilege injected credential.",
  },
  {
    name: "secret.slack-token",
    pattern: makePattern(["\\bxox", "[baprs]-[A-Za-z0-9-]{10,}\\b"]),
    remediation:
      "Revoke the Slack token and load its replacement from an approved secret store.",
  },
  {
    name: "secret.jwt",
    pattern: makePattern([
      "\\beyJ[A-Za-z0-9_-]{5,}\\.",
      "eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{8,}\\b",
    ]),
    remediation:
      "Invalidate the JWT if it is active and obtain it at runtime instead of storing it in the repository.",
  },
  {
    name: "secret.google-api-key",
    pattern: makePattern(["\\bAI", "za[0-9A-Za-z_-]{35}\\b"]),
    remediation:
      "Restrict and rotate the Google API key, then inject it at runtime.",
  },
  {
    name: "secret.live-payment-provider-key",
    pattern: makePattern([
      "\\b(?:s",
      "k_live_[0-9A-Za-z]{16,}|r",
      "k_live_[0-9A-Za-z]{16,}|rzp",
      "_live_[0-9A-Za-z]{12,}|sq0atp-[0-9A-Za-z_-]{20,}|FLWSECK-[0-9A-Za-z_-]{12,}-X)\\b",
    ]),
    remediation:
      "Revoke and rotate the live payment credential, then use the provider's approved secret injection method.",
  },
  {
    name: "secret.aws-signed-storage-url",
    pattern: makePattern(
      [
        "(?:https?://[^\\s'\"]{1,2048}[?&]X-Amz-",
        "Signature=[A-Fa-f0-9]{16,256}\\b",
        "|\\bX-Amz-",
        "Signature\\b[\\s'\"]*(?:=|:)[\\s'\"]*[A-Fa-f0-9]{16,256}\\b)",
      ],
      "iu",
    ),
    remediation:
      "Remove the signed AWS URL and generate a short-lived URL only when it is needed.",
  },
  {
    name: "secret.google-signed-storage-url",
    pattern: makePattern(
      [
        "https?://(?:storage\\.googleapis\\.com|storage\\.cloud\\.google\\.com)",
        "[^\\s'\"]{1,2048}[?&](?:X-Goog-Signature|Signature)=",
        "[A-Za-z0-9%_-]{16,}",
      ],
      "iu",
    ),
    remediation:
      "Remove the signed Google Cloud Storage URL and generate a short-lived URL only when it is needed.",
  },
  {
    name: "secret.hard-coded-credential",
    // Match the complete assignment, but validate the captured value separately
    // so placeholders and runtime references remain allowed.
    pattern: makePattern(
      [
        "(?<![\\w-])",
        `(?:["]${credentialKey}["]|'${credentialKey}'|${credentialKey})`, // scanner-definition: credential assignment names
        "\\s*(?:=|:)\\s*",
        "(?:[\"](?<doubleQuoted>[^\"\\r\\n]{8,})[\"]|'(?<singleQuoted>[^'\\r\\n]{8,})'|(?<unquoted>[^,};#\\r\\n]{8,}?)(?=\\s*(?:,|\\}|;|#|$)))",
      ],
      "gimu",
    ),
    valueIsSafe: (value, { path, quoted }) => {
      const candidate = value.trim();
      return (
        explicitPlaceholder(candidate) ||
        (!quoted &&
          isSourceCodePath(path) &&
          (/^(?:process\.env|import\.meta\.env|Deno\.env|Bun\.env|os\.environ|ENV)(?:\.|\[)/u.test(
            candidate,
          ) ||
            /^(?:env|getenv|secret)\([\s\S]+\)$/iu.test(candidate) ||
            isStructuredRuntimeExpression(candidate)))
      );
    },
    remediation:
      "Remove the hard-coded credential, rotate it if real, and load it from an approved secret store.",
  },
];

// The only source exclusion is the generic rule's own marked definition line.
// Token-specific rules and every other line and path remain enabled.
const sourceExclusions = [
  {
    path: "scripts/repository-scan-rules.mjs",
    rule: "secret.hard-coded-credential",
    lineMarker: "scanner-definition: credential assignment names",
  },
];

export const normalizePath = (path) => path.replaceAll("\\", "/");

export const configuredSafeLimit = () => {
  const configured = process.env.REPOSITORY_SCAN_MAX_FILE_SIZE_BYTES;
  if (configured === undefined) return DEFAULT_MAX_FILE_SIZE_BYTES;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(
      "REPOSITORY_SCAN_MAX_FILE_SIZE_BYTES must be a positive integer.",
    );
  }
  return parsed;
};

export const findSecrets = (path, content) => {
  const findings = [];
  const lines = content.split(/\r?\n/u);
  for (const rule of secretRules) {
    const markers = sourceExclusions
      .filter((item) => item.path === path && item.rule === rule.name)
      .map((item) => item.lineMarker);
    const searchable = lines
      .filter((line) => !markers.some((marker) => line.includes(marker)))
      .join("\n");
    rule.pattern.lastIndex = 0;
    if (rule.valueIsSafe === undefined) {
      if (rule.pattern.test(searchable)) findings.push(rule);
      continue;
    }
    for (const match of searchable.matchAll(rule.pattern)) {
      const value =
        match.groups?.doubleQuoted ??
        match.groups?.singleQuoted ??
        match.groups?.unquoted;
      const quoted = match.groups?.unquoted === undefined;
      if (value !== undefined && !rule.valueIsSafe(value, { path, quoted })) {
        findings.push(rule);
        break;
      }
    }
  }
  return findings;
};

export const pathFindings = (path) => {
  const normalized = normalizePath(path);
  const findings = [];
  if (forbiddenExtensions.has(extname(normalized).toLowerCase())) {
    findings.push({
      name: "privacy.prohibited-extension",
      remediation:
        "Remove the private-data, archive, database, key, or model file and keep it in approved private storage.",
    });
  }
  const isRootEnvironmentExample = normalized === ".env.example";
  if (
    !isRootEnvironmentExample &&
    forbiddenPaths.some((pattern) => pattern.test(normalized))
  ) {
    findings.push({
      name: "privacy.prohibited-path",
      remediation:
        "Remove or rename the prohibited private-data path and keep private evidence outside this repository.",
    });
  }
  return findings;
};

export const addFinding = (findings, rule, path, identifiers = {}) => {
  findings.push({
    rule: rule.name,
    path,
    remediation: rule.remediation,
    ...identifiers,
  });
};
