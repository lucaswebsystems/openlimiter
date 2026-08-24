/**
 * Freeze gate for the OpenLimiter identity.
 *
 * Run with --write only after the owner explicitly approves a canonical logo
 * change. Ordinary CI verifies hashes and rejects copied inline logo paths.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL = "assets/brand/openlimiter-lockup.svg";
const MANIFEST_PATH = path.join(ROOT, "assets", "brand", "manifest.json");
const STATIC_OUTPUTS = [
  "assets/brand/openlimiter-lockup-dark.svg",
  "assets/brand/openlimiter-lockup-light.svg",
  "assets/brand/openlimiter-mark.svg",
  "assets/brand/openlimiter-tile-1024.png",
  "assets/brand/generator.provenance.json",
  "assets/brand/web-icons.provenance.json",
  "assets/brand/desktop-icons.provenance.json",
  "apps/web/lib/brand.generated.ts",
];
const GENERATED_DIRS = [
  "apps/web/public/brand",
  "apps/web/public/icons",
  "apps/desktop/ui/brand",
  "apps/desktop/src-tauri/icons",
];
const SOURCE_EXTENSIONS = new Set([".css", ".html", ".js", ".jsx", ".md", ".mjs", ".ts", ".tsx"]);
const OMIT_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".worktrees",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

function relative(file) {
  return path.relative(ROOT, file).replaceAll("\\", "/");
}

function filesUnder(directory) {
  const root = path.join(ROOT, directory);
  if (!existsSync(root)) return [];
  const found = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (OMIT_DIRS.has(entry.name) || entry.name.startsWith(".next"))
      ) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) found.push(relative(absolute));
    }
  };
  visit(root);
  return found;
}

function hash(relativePath) {
  return createHash("sha256")
    .update(readFileSync(path.join(ROOT, relativePath)))
    .digest("hex");
}

function outputPaths() {
  return [...new Set([
    ...STATIC_OUTPUTS,
    ...GENERATED_DIRS.flatMap(filesUnder),
  ])].sort();
}

function snapshot() {
  return {
    version: 1,
    canonical: {
      path: CANONICAL,
      sha256: hash(CANONICAL),
    },
    outputs: Object.fromEntries(outputPaths().map((file) => [file, hash(file)])),
  };
}

function checkProvenance(canonicalSha256) {
  for (const file of [
    "assets/brand/generator.provenance.json",
    "assets/brand/web-icons.provenance.json",
    "assets/brand/desktop-icons.provenance.json",
  ]) {
    const provenance = JSON.parse(readFileSync(path.join(ROOT, file), "utf8"));
    if (provenance.canonicalSha256 !== canonicalSha256) {
      throw new Error(`${file} is stale against the frozen canonical lockup.`);
    }
  }
}

function checkNoInlineCopies() {
  const canonical = readFileSync(path.join(ROOT, CANONICAL), "utf8");
  const frozenPaths = [...canonical.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(
    (match) => match[1],
  );
  frozenPaths.push(
    ["M 43.369 141.145", "A 70 70 0 1 1", "156.631 141.145"].join(" "),
  );
  const violations = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (OMIT_DIRS.has(entry.name) || entry.name.startsWith(".next"))
      ) continue;
      const absolute = path.join(current, entry.name);
      const rel = relative(absolute);
      if (rel.startsWith("assets/brand/")) continue;
      if (rel === "scripts/check-brand.mjs") continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const source = readFileSync(absolute, "utf8");
      for (const pathData of frozenPaths) {
        if (source.includes(pathData)) violations.push(rel);
      }
    }
  };
  visit(ROOT);
  if (violations.length > 0) {
    throw new Error(
      "Inline OpenLimiter logo path found outside assets/brand:\n" +
        [...new Set(violations)].sort().join("\n"),
    );
  }
}

if (process.argv.includes("--write")) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(snapshot(), null, 2) + "\n");
  process.stdout.write("Wrote the frozen brand manifest.\n");
} else {
  if (!existsSync(MANIFEST_PATH)) throw new Error("Brand manifest is missing.");
  const expected = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const actual = snapshot();
  checkProvenance(actual.canonical.sha256);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "The canonical logo or a generated output is stale. Owner approval and " +
        "node scripts/check-brand.mjs --write are required for an intentional change.",
    );
  }
  checkNoInlineCopies();
  process.stdout.write(
    `Brand freeze verified: ${String(Object.keys(actual.outputs).length)} generated outputs.\n`,
  );
}
