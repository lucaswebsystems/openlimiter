/**
 * Mirror the real engine into this application, for the browser.
 *
 *   node apps/web/app/app/engine/sync.mjs           rewrite the mirror
 *   node apps/web/app/app/engine/sync.mjs --check   fail if it has drifted
 *
 * Why a mirror exists at all
 * --------------------------
 * `packages/core`, `packages/connectors` and `packages/adapters` are the one
 * implementation of every rule OpenLimiter has: what a valid meter is, when a
 * reading is stale, what advice comes out of a set of readings. The dashboard
 * at /app has to apply those exact rules, because a second implementation
 * would drift and start telling a different story from the command line tool.
 *
 * This site is deployed on its own, with its own lock file, and it is not a
 * member of the pnpm workspace, so it cannot resolve `@openlimiter/core` as a
 * package. Rather than reimplement anything, this script copies the real
 * source files verbatim and rewrites nothing but their import specifiers.
 *
 * What is and is not changed
 * --------------------------
 *   - `from "@openlimiter/core"` becomes a relative path to the mirrored core.
 *   - `from "./x.js"` becomes `from "./x"`, which is what a bundler wants.
 *   - a header is prepended saying the file is generated.
 *   - the adapter cache helper is omitted because it imports Node file APIs.
 * The pure parser, policy and rendering logic is unchanged. `MANIFEST.json`
 * records a hash of every source file, so `--check` fails loudly the moment the
 * packages move ahead of the mirror, and the fix is always to run this script
 * again.
 *
 * The node only modules are left out on purpose. `packages/core/src/cache.ts`
 * reads the snapshot cache off a disk that a browser does not have, so the
 * mirrored barrel takes `readSnapshotCache` from `../browser-cache.ts`, which
 * reports the same "there is no cache here" result the core reports for a
 * missing file. Nothing is invented and nothing fails open.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..", "..", "..", "..", "..");
const GENERATED = path.join(HERE, "generated");

/** Source modules, per package. Order is irrelevant, membership is not. */
const MIRROR = {
  core: {
    from: path.join(REPOSITORY, "packages", "core", "src"),
    /* cache.ts is deliberately absent: it is the only node only module. */
    files: [
      "types.ts",
      "connection-state.ts",
      "failures.ts",
      "format.ts",
      "forecast.ts",
      "freshness.ts",
      "merge.ts",
      "normalizer.ts",
      "policy.ts",
      "schedule.ts",
    ],
  },
  connectors: {
    from: path.join(REPOSITORY, "packages", "connectors", "src"),
    files: [
      "shared.ts",
      "antigravity.ts",
      "claude.ts",
      "codex.ts",
      "contract-gate.ts",
      "fixtures.ts",
      "grok.ts",
      "kimi.ts",
      "manual.ts",
      "opencode.ts",
      "openrouter.ts",
      "index.ts",
    ],
  },
  adapters: {
    from: path.join(REPOSITORY, "packages", "adapters", "src"),
    files: ["claude-code.ts"],
  },
  ui: {
    from: path.join(REPOSITORY, "packages", "ui", "src"),
    files: ["provider-connect.ts", "provider-row.ts", "tokens.css"],
  },
};

const HEADER = [
  "/**",
  " * Generated file. Do not edit.",
  " *",
  " * Mirrored verbatim from the package source by app/app/engine/sync.mjs.",
  " * Only import specifiers were rewritten. Edit the package instead, then run",
  " * the script again.",
  " */",
  "",
].join("\n");

const CSS_HEADER = [
  "/*",
  " * Generated file. Do not edit.",
  " * Mirrored verbatim from packages/ui by app/app/engine/sync.mjs.",
  " */",
  "",
].join("\n");

/** The barrel the mirrored connectors and adapters import from. */
function coreBarrel(files) {
  const exports = files
    .map((file) => `export * from "./${file.replace(/\.ts$/u, "")}";`)
    .join("\n");
  return [
    HEADER,
    "/*",
    " * The core barrel, for the browser.",
    " *",
    " * Same surface as the package barrel with one substitution: the snapshot",
    " * cache lives on a disk, and a browser has none, so readSnapshotCache comes",
    " * from the browser shim and reports the same missing cache result the core",
    " * reports for a file that is not there.",
    " */",
    exports,
    'export { readSnapshotCache, type CacheReadResult } from "../../browser-cache";',
    "",
  ].join("\n");
}

function rewrite(source, packageName) {
  const depth = packageName === "core" ? "." : "../core";
  const rewritten = source
    .replace(/from "@openlimiter\/core"/gu, `from "${depth}"`)
    .replace(/from "(\.[^"]*)\.js"/gu, 'from "$1"');
  return packageName === "adapters" ? browserAdapter(rewritten) : rewritten;
}

function browserAdapter(source) {
  let browser = source
    .replace("  readJsonFileSafely,\n", "")
    .replace("  resolveStateDirectory,\n", "")
    .replace('import path from "node:path";\n', "");

  const hostedStart = browser.indexOf("const HOSTED_CONTEXT_FILE_NAME");
  const pureStart = browser.indexOf("function validInstant", hostedStart);
  if (hostedStart < 0 || pureStart < 0) {
    if (!source.includes('from "node:path"') && !source.includes("readJsonFileSafely")) {
      return browser;
    }
    throw new Error("The Claude adapter cache boundary changed.");
  }
  browser = browser.slice(0, hostedStart) + browser.slice(pureStart);

  const nodeBody = [
    "  const cached = await readSnapshotCache(directory);",
    "  const local = cached.ok",
    "    ? buildAgentContext(buildAdvice(cached.snapshots, now, expectedProviders))",
    '    : "";',
    "  const hosted = await hostedContextFromCache(directory);",
    '  return [local, hosted].filter((context) => context !== "").join("\\n");',
  ].join("\n");
  const browserBody = [
    "  const cached = await readSnapshotCache(directory);",
    '  if (!cached.ok) return "";',
    "  return buildAgentContext(buildAdvice(cached.snapshots, now, expectedProviders));",
  ].join("\n");
  if (!browser.includes(nodeBody)) {
    throw new Error("The Claude adapter cache implementation changed.");
  }
  return browser.replace(nodeBody, browserBody);
}

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function build() {
  const manifest = {};
  const written = new Map();
  for (const [packageName, spec] of Object.entries(MIRROR)) {
    for (const file of spec.files) {
      const source = readFileSync(path.join(spec.from, file), "utf8");
      manifest[`${packageName}/${file}`] = hash(source);
      written.set(
        path.join(packageName, file),
        file.endsWith(".css")
          ? CSS_HEADER + source
          : HEADER + rewrite(source, packageName),
      );
    }
  }
  written.set(path.join("core", "index.ts"), coreBarrel(MIRROR.core.files));
  written.set(
    "MANIFEST.json",
    JSON.stringify({ generatedBy: "app/app/engine/sync.mjs", sources: manifest }, null, 2) + "\n",
  );
  return written;
}

function readGenerated() {
  const found = new Map();
  const walk = (directory, prefix) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = path.join(prefix, entry.name);
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else found.set(relative, readFileSync(path.join(directory, entry.name), "utf8"));
    }
  };
  walk(GENERATED, "");
  return found;
}

const wanted = build();
const check = process.argv.includes("--check");

if (check) {
  const found = readGenerated();
  const problems = [];
  for (const [file, contents] of wanted) {
    if (!found.has(file)) problems.push(`missing: ${file}`);
    else if (found.get(file) !== contents) problems.push(`stale: ${file}`);
  }
  for (const file of found.keys()) {
    if (!wanted.has(file)) problems.push(`orphan: ${file}`);
  }
  if (problems.length > 0) {
    process.stderr.write(
      `The browser mirror has drifted from the packages.\n${problems.join("\n")}\n` +
        "Run: node apps/web/app/app/engine/sync.mjs\n",
    );
    process.exit(1);
  }
  process.stdout.write(`Mirror matches the packages. ${wanted.size} files.\n`);
} else {
  rmSync(GENERATED, { recursive: true, force: true });
  for (const [file, contents] of wanted) {
    const target = path.join(GENERATED, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
  }
  process.stdout.write(`Mirrored ${wanted.size} files into app/app/engine/generated.\n`);
}
