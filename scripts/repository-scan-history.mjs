import { spawnSync } from "node:child_process";

import {
  addFinding,
  findSecrets,
  normalizePath,
  pathFindings,
} from "./repository-scan-rules.mjs";

export const HISTORY_INVENTORY_GIT_PROCESS_COUNT = 3;

const runGitBatch = (safeDirectory, args, input, encoding = "utf8") => {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${safeDirectory}`, ...args],
    {
      cwd: process.cwd(),
      encoding,
      input,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to run Git history scan command: ${args[0]}.`);
  }
  return result.stdout;
};

const addHistoricalLocation = (pathsByObject, object, path, commit) => {
  if (/^0+$/u.test(object)) return;
  const normalized = normalizePath(path);
  const existing = pathsByObject.get(object) ?? new Map();
  if (!existing.has(normalized)) existing.set(normalized, commit);
  pathsByObject.set(object, existing);
};

const historicalPaths = (git) => {
  const output = git([
    "log",
    "--all",
    "--root",
    "--raw",
    "-m",
    "--no-abbrev",
    "--no-renames",
    "-z",
    "--format=%x1e%H%x00",
  ]);
  const pathsByObject = new Map();
  const rawEntry =
    /:[0-7]{6} [0-7]{6} ([0-9a-f]+) ([0-9a-f]+) [A-Z][0-9]*\0([^\0]*)\0/gu;

  for (const commitRecord of output.split("\x1e")) {
    if (commitRecord.length === 0) continue;
    const headerEnd = commitRecord.indexOf("\0");
    if (headerEnd === -1) continue;
    const commit = commitRecord.slice(0, headerEnd).trim();
    if (!/^[0-9a-f]+$/u.test(commit)) continue;

    rawEntry.lastIndex = 0;
    for (const match of commitRecord.slice(headerEnd + 1).matchAll(rawEntry)) {
      const newObject = match[2];
      const path = match[3];
      if (newObject === undefined || path === undefined) continue;
      // The new object is present in this commit's tree. The old object belongs
      // to the parent tree, so assigning it here would attribute replaced or
      // deleted content to the commit that no longer contains it.
      addHistoricalLocation(pathsByObject, newObject, path, commit);
    }
  }

  return pathsByObject;
};

export const committedBlobInventory = (git, safeDirectory) => {
  // No filenames are parsed here. Historical filenames come only from the
  // NUL-delimited raw log traversal below.
  const objectIds = [
    ...new Set(
      git(["rev-list", "--objects", "--all", "--no-object-names"])
        .split(/\r?\n/u)
        .filter(Boolean),
    ),
  ];
  if (objectIds.length === 0) return [];

  const pathsByObject = historicalPaths(git);
  const checked = runGitBatch(
    safeDirectory,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    `${objectIds.join("\n")}\n`,
  );

  return checked
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [object, type, sizeText] = line.split(" ");
      const historical = pathsByObject.get(object);
      const locations =
        historical === undefined
          ? [{ path: "(no historical path recorded)" }]
          : [...historical].map(([path, commit]) => ({ path, commit }));
      return {
        object,
        type,
        size: Number(sizeText),
        locations,
      };
    })
    .filter((object) => object.type === "blob");
};

const readBlobContents = (blobs, safeDirectory, maxFileSizeBytes) => {
  const objectIds = blobs
    .filter((blob) => blob.size <= maxFileSizeBytes)
    .map((blob) => blob.object);
  const contents = new Map();
  if (objectIds.length === 0) return contents;

  const output = runGitBatch(
    safeDirectory,
    ["cat-file", "--batch"],
    Buffer.from(`${objectIds.join("\n")}\n`, "utf8"),
    null,
  );

  let offset = 0;
  while (offset < output.length) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) break;
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]+) blob ([0-9]+)$/u.exec(header);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("Unable to parse batched Git blob output.");
    }
    const size = Number(match[2]);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    contents.set(
      match[1],
      output.subarray(contentStart, contentEnd).toString("utf8"),
    );
    offset = contentEnd + 1;
  }

  return contents;
};

export const scanHistory = (git, safeDirectory, maxFileSizeBytes) => {
  const blobs = committedBlobInventory(git, safeDirectory);
  const contents = readBlobContents(blobs, safeDirectory, maxFileSizeBytes);
  const findings = [];

  for (const blob of blobs) {
    for (const location of blob.locations) {
      const identifiers = { object: blob.object };
      if (location.commit !== undefined) identifiers.commit = location.commit;
      for (const rule of pathFindings(location.path)) {
        addFinding(findings, rule, location.path, identifiers);
      }
      if (blob.size > maxFileSizeBytes) {
        addFinding(
          findings,
          {
            name: "privacy.file-over-safe-limit",
            remediation:
              "Purge the oversized blob from Git history and keep it in approved external storage.",
          },
          location.path,
          identifiers,
        );
      }
    }

    const content = contents.get(blob.object);
    if (content === undefined) continue;
    for (const location of blob.locations) {
      const identifiers = { object: blob.object };
      if (location.commit !== undefined) identifiers.commit = location.commit;
      for (const rule of findSecrets(location.path, content)) {
        addFinding(findings, rule, location.path, identifiers);
      }
    }
  }

  return { blobsChecked: blobs.length, findings };
};
