/**
 * Assemble the desktop front end.
 *
 *   node apps/desktop/scripts/build-ui.mjs
 *
 * The window runs the engine that is already built. This script copies the
 * compiled JavaScript out of packages/core, packages/connectors and
 * packages/adapters into ui/dist/engine, rewrites the one bare import
 * specifier a bundler would normally resolve, and copies the files the
 * window itself is made of. There is no bundler, no transpiler, and no third
 * party dependency anywhere in the result.
 *
 * Two modules are deliberately left out of the copy:
 *
 *   core/cache.js reads a file from disk with node's file system module, which
 *   a webview does not have. The window gets the same bytes through a Tauri
 *   command instead, and the barrel below supplies a readSnapshotCache that
 *   reports the same missing cache the core reports for a file that is absent.
 *
 *   core/index.js is the package barrel, which re-exports cache.js. A barrel
 *   written here takes its place, exporting exactly the same surface minus
 *   that one module.
 *
 * The Claude adapter also omits its Node only hosted cache helper. Its pure
 * context and statusline renderers remain the code the command line tool runs.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..");
const REPOSITORY = path.resolve(DESKTOP, "..", "..");
const DIST = path.join(DESKTOP, "ui", "dist");
const ENGINE = path.join(DIST, "engine");

/** Compiled modules to copy, per package. */
const COPY = {
  core: {
    from: path.join(REPOSITORY, "packages", "core", "dist"),
    files: [
      "types.js",
      "collection.js",
      "connection-state.js",
      "failures.js",
      "format.js",
      "forecast.js",
      "freshness.js",
      "merge.js",
      "normalizer.js",
      "policy.js",
      "schedule.js",
    ],
  },
  connectors: {
    from: path.join(REPOSITORY, "packages", "connectors", "dist"),
    files: [
      "shared.js",
      "antigravity.js",
      "claude.js",
      "codex.js",
      "contract-gate.js",
      "fixtures.js",
      "gemini-cli.js",
      "grok.js",
      "kimi.js",
      "manual.js",
      "opencode.js",
      "openrouter.js",
      "index.js",
    ],
  },
  adapters: {
    from: path.join(REPOSITORY, "packages", "adapters", "dist"),
    files: ["claude-code.js"],
  },
  ui: {
    from: path.join(REPOSITORY, "packages", "ui", "dist"),
    files: ["provider-connect.js", "provider-row.js"],
  },
};

const CORE_BARREL = `/*
 * The core barrel, for a webview.
 *
 * Written by apps/desktop/scripts/build-ui.mjs. Same surface as the package
 * barrel with one substitution: the snapshot cache lives on a disk that this
 * process reaches through a Tauri command, not through node, so
 * readSnapshotCache reports the same missing cache the core reports for a file
 * that is not there. Nothing is invented and nothing fails open.
 */
${COPY.core.files.map((file) => `export * from "./${file}";`).join("\n")}

export async function readSnapshotCache() {
  return { ok: false, reason: "missing" };
}

/*
 * Mirrored from cache.js by hand, because cache.js itself cannot be copied.
 * The desktop's refresh pipeline writes the cache document through the Rust
 * lock handshake and must produce the exact document the CLI writes, version
 * field included. Bump this only when packages/core/src/cache.ts bumps.
 *
 * Version 2 added the suppressions array, which is an instruction to distrust
 * rows that are still in the document. A reader that ignores it shows a number
 * the writer was withdrawing, which is a misread rather than an omission, and
 * that is what the number is for.
 */
export const CACHE_DOCUMENT_VERSION = 2;
`;

function assertBuilt() {
  for (const [name, spec] of Object.entries(COPY)) {
    const probe = path.join(spec.from, spec.files[0]);
    try {
      readFileSync(probe);
    } catch {
      process.stderr.write(
        `The ${name} package has not been built, so there is nothing to copy.\n` +
          "Run pnpm build at the repository root first.\n",
      );
      process.exit(1);
    }
  }
}

function browserSafeAdapter(source) {
  if (!source.includes('from "node:path"')) return source;

  let browser = source
    .replace(/\breadJsonFileSafely,\s*/u, "")
    .replace(/\bresolveStateDirectory,\s*/u, "")
    .replace(/import path from "node:path";\s*/u, "");
  const hostedStart = browser.indexOf("const HOSTED_CONTEXT_FILE_NAME");
  const pureStart = browser.indexOf("function validInstant", hostedStart);
  if (hostedStart < 0 || pureStart < 0) {
    throw new Error("The Claude adapter cache boundary changed.");
  }
  browser = browser.slice(0, hostedStart) + browser.slice(pureStart);

  const cacheStart = browser.indexOf("export async function agentContextFromCache");
  if (cacheStart < 0) {
    throw new Error("The Claude adapter cache export changed.");
  }
  return browser.slice(0, cacheStart);
}

assertBuilt();
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
writeFileSync(path.join(DIST, ".gitkeep"), "\n", "utf8");

for (const [name, spec] of Object.entries(COPY)) {
  const target = path.join(ENGINE, name);
  mkdirSync(target, { recursive: true });
  for (const file of spec.files) {
    const source = readFileSync(path.join(spec.from, file), "utf8");
    /* The only specifier a webview cannot resolve on its own. */
    const rewritten = source.replace(
      /from "@openlimiter\/core"/gu,
      'from "../core/index.js"',
    );
    const browserSource = name === "adapters" ? browserSafeAdapter(rewritten) : rewritten;
    writeFileSync(path.join(target, file), browserSource, "utf8");
  }
}

writeFileSync(path.join(ENGINE, "core", "index.js"), CORE_BARREL, "utf8");

/* CSS custom properties inherit through the shared row's shadow root. Copy the
   canonical product token sheet beside the shared component so the desktop
   and web surfaces consume the same values rather than matching by hand. */
copyFileSync(
  path.join(REPOSITORY, "packages", "ui", "src", "tokens.css"),
  path.join(ENGINE, "ui", "tokens.css"),
);

/* The window itself. theme.css holds every colour, radius and the embedded
   wordmark face; app.css draws the components and names no literal. That is
   the same token layer and component layer split the web side makes, and it is
   what lets the design lint exempt the one file that defines values.
   backend.js is the one module allowed to name a Tauri command, and
   connections.js is the Connections tab that talks through it. */
const WINDOW_FILES = [
  "index.html",
  /* Generated by scripts/validate-provider-specs.mjs. The window renders the
     honesty labels from this and from nowhere else, so a build that omitted it
     would draw cards with no labels at all rather than with softened ones. */
  "provider-specs.generated.js",
  "theme.css",
  "app.css",
  "app.js",
  "backend.js",
  "connections.js",
  "first-run.js",
];

for (const file of WINDOW_FILES) {
  copyFileSync(path.join(DESKTOP, "ui", file), path.join(DIST, file));
}

const copied = Object.values(COPY).reduce((total, spec) => total + spec.files.length, 0);
process.stdout.write(
  `Assembled ui/dist from ${String(copied)} compiled modules, one token sheet and ` +
    `${String(WINDOW_FILES.length)} window files.\n`,
);
