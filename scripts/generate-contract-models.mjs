import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const schemaPath = resolve("packages/schemas/schema/contracts.schema.json");
const typescriptPath = resolve("packages/schemas/src/generated.ts");
const pythonPath = resolve(
  "packages/schemas/python/oilspill_contracts/generated.py",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const modelNames = [
  "AOI",
  "Scene",
  "ProcessingJob",
  "ModelVersion",
  "Candidate",
  "CandidateAsset",
  "Review",
  "AlertDelivery",
  "ProviderUsageSnapshot",
  "ProviderJobRun",
  "CreditLedgerEntry",
];

const refName = (ref) => ref.split("/").at(-1);

const tsType = (value) => {
  if (value.$ref !== undefined) return refName(value.$ref);
  if (value.const !== undefined) return JSON.stringify(value.const);
  if (value.enum !== undefined)
    return value.enum.map((item) => JSON.stringify(item)).join(" | ");
  if (value.oneOf !== undefined)
    return value.oneOf.map((item) => tsType(item)).join(" | ");
  if (value.prefixItems !== undefined)
    return `[${value.prefixItems.map((item) => tsType(item)).join(", ")}]`;
  if (value.type === "array") return `Array<${tsType(value.items ?? {})}>`;
  if (value.type === "string") return "string";
  if (value.type === "integer" || value.type === "number") return "number";
  if (value.type === "boolean") return "boolean";
  if (value.type === "null") return "null";
  if (value.type === "object") {
    const required = new Set(value.required ?? []);
    const properties = Object.entries(value.properties ?? {}).map(
      ([name, property]) =>
        `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${tsType(property)};`,
    );
    return `{ ${properties.join(" ")} }`;
  }
  return "unknown";
};

const pyType = (value) => {
  if (value.$ref !== undefined) return refName(value.$ref);
  if (value.const !== undefined)
    return `Literal[${JSON.stringify(value.const)}]`;
  if (value.enum !== undefined)
    return `Literal[${value.enum.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (value.oneOf !== undefined)
    return value.oneOf.map((item) => pyType(item)).join(" | ");
  if (value.prefixItems !== undefined)
    return `tuple[${value.prefixItems.map((item) => pyType(item)).join(", ")}]`;
  if (value.type === "array") return `list[${pyType(value.items ?? {})}]`;
  if (value.type === "string") return "str";
  if (value.type === "integer") return "int";
  if (value.type === "number") return "float";
  if (value.type === "boolean") return "bool";
  if (value.type === "null") return "None";
  if (value.type === "object") return "dict[str, object]";
  return "object";
};

const tsDefinitions = Object.entries(schema.$defs)
  .map(([name, definition]) => {
    if (definition.type === "object" && definition.oneOf === undefined) {
      const required = new Set(definition.required ?? []);
      const fields = Object.entries(definition.properties ?? {})
        .map(
          ([field, property]) =>
            `  ${JSON.stringify(field)}${required.has(field) ? "" : "?"}: ${tsType(property)};`,
        )
        .join("\n");
      return `export interface ${name} {\n${fields}\n}`;
    }
    return `export type ${name} = ${tsType(definition)};`;
  })
  .join("\n\n");

const pythonDefinitions = Object.entries(schema.$defs)
  .map(([name, definition]) => {
    if (definition.type === "object" && definition.oneOf === undefined) {
      const fields = Object.entries(definition.properties ?? {})
        .map(([field, property]) => `    ${field}: ${pyType(property)}`)
        .join("\n");
      return `class ${name}(TypedDict):\n${fields || "    pass"}`;
    }
    return `${name}: TypeAlias = ${pyType(definition)}`;
  })
  .join("\n\n");

const typescript = `// Generated from packages/schemas/schema/contracts.schema.json. Do not edit.\nexport const contractSchemaVersion = ${JSON.stringify(schema.schema_version)} as const;\nexport const contractModelNames = ${JSON.stringify(modelNames)} as const;\n\n${tsDefinitions}\n\nexport type ContractModel = ${modelNames.join(" | ")};\n`;

const rawPython = `"""Generated from contracts.schema.json. Do not edit."""\n\nfrom typing import Literal, TypeAlias, TypedDict\n\nCONTRACT_SCHEMA_VERSION = ${JSON.stringify(schema.schema_version)}\nCONTRACT_MODEL_NAMES = ${JSON.stringify(modelNames)}\n\n${pythonDefinitions}\n\nContractModel: TypeAlias = ${modelNames.join(" | ")}\n`;

const pythonExecutable =
  process.platform === "win32"
    ? join(".venv", "Scripts", "python.exe")
    : join(".venv", "bin", "python");
if (!existsSync(pythonExecutable)) {
  throw new Error(
    "Python environment is missing. Run npm run setup:python first.",
  );
}
const black = spawnSync(pythonExecutable, ["-m", "black", "--quiet", "-"], {
  cwd: process.cwd(),
  encoding: "utf8",
  input: rawPython,
  shell: false,
});
if (black.error !== undefined || black.status !== 0) {
  throw new Error(`Unable to format generated Python model: ${black.stderr}`);
}
const python = black.stdout;

const outputs = [
  [typescriptPath, typescript],
  [pythonPath, python],
];

if (process.argv.includes("--check")) {
  const stale = outputs
    .filter(([path, contents]) => {
      try {
        return readFileSync(path, "utf8") !== contents;
      } catch {
        return true;
      }
    })
    .map(([path]) => path);
  if (stale.length > 0) {
    console.error(
      `Generated contract models are stale:\n${stale.join("\n")}\nRun npm run types:generate.`,
    );
    process.exitCode = 1;
  } else {
    console.log("Generated Python and TypeScript contract models are current.");
  }
} else {
  for (const [path, contents] of outputs) writeFileSync(path, contents, "utf8");
  console.log("Generated Python and TypeScript contract models.");
}
