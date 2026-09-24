import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const markdownFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? markdownFiles(path)
      : path.endsWith(".md")
        ? [path.replaceAll("\\", "/")]
        : [];
  });

const paths = ["README.md", ...markdownFiles("docs")].sort();
const manifest = {
  format: 1,
  files: paths.map((path) => ({
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  })),
};
const output = join("build", "docs", "manifest.json");
const temporary = `${output}.tmp`;
mkdirSync(dirname(output), { recursive: true });
writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
renameSync(temporary, output);
console.log(`Documentation manifest built for ${paths.length} Markdown files.`);
