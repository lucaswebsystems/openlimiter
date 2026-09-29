import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const config = JSON.parse(
  readFileSync(resolve(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
);
const macConfig = JSON.parse(
  readFileSync(
    resolve(root, "apps/desktop/src-tauri/tauri.macos-unsigned.conf.json"),
    "utf8",
  ),
);

const endpoint =
  "https://github.com/lucaswebsystems/openlimiter/releases/latest/download/latest.json";
const pubkey =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ1RjI0OTAxM0Y3NzVGNDEKUldSQlgzYy9BVW55MVVZNlVtc3ljcklzdnNzS052TmY0d1A1S2R4T005SFJkYm1QMThobE9VWG4K";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

requireCondition(
  JSON.stringify(config.plugins?.updater?.endpoints) === JSON.stringify([endpoint]),
  "The updater endpoint differs from the reviewed release URL",
);
requireCondition(
  config.plugins?.updater?.pubkey === pubkey,
  "The updater public key differs from the reviewed key",
);
requireCondition(
  config.bundle?.createUpdaterArtifacts === true,
  "Windows and Linux updater artifact generation must remain enabled",
);
for (const target of ["app", "dmg"]) {
  requireCondition(
    config.bundle?.targets?.includes(target),
    `The base bundle targets do not include macOS ${target}`,
  );
}
requireCondition(
  config.bundle?.icon?.includes("icons/icon.icns"),
  "The macOS icon is missing from the bundle",
);
requireCondition(
  JSON.stringify(macConfig.bundle?.targets) === JSON.stringify(["app", "dmg"]),
  "The unsigned macOS overlay must build only app and dmg",
);
requireCondition(
  macConfig.bundle?.createUpdaterArtifacts === false,
  "The unsigned macOS overlay must disable updater artifacts",
);
requireCondition(
  macConfig.bundle?.macOS?.signingIdentity === null,
  "The unsigned macOS overlay must not select a signing identity",
);

export function updaterPlatforms(workflow) {
  // Read only the build matrix, not the installer verification matrix.
  const matrix = workflow.split(/^  build:\s*$/mu)[1]?.split(/^    steps:\s*$/mu)[0];
  requireCondition(matrix, "The desktop build matrix was not found");
  const platforms = [];
  for (const entry of matrix.split(/^          - os:/mu).slice(1)) {
    if (!/^            updater: true\s*$/mu.test(entry)) continue;
    const targets = entry.match(/^            rust_targets: (.+)$/mu)?.[1].trim().split(",");
    requireCondition(targets?.length, "An updater build has no Rust targets");
    for (const target of targets) {
      const match = target.match(/^(x86_64|aarch64|i686)-(unknown-linux-gnu|pc-windows-msvc)$/u);
      requireCondition(match, `Unsupported updater build target: ${target}`);
      platforms.push(`${match[2].includes("windows") ? "windows" : "linux"}-${match[1]}`);
    }
  }
  requireCondition(platforms.length > 0, "The build matrix has no updater platforms");
  return [...new Set(platforms)];
}

function base64(value, label) {
  requireCondition(
    typeof value === "string" && value.length > 0 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value),
    `Invalid base64 in ${label}`,
  );
  return Buffer.from(value, "base64");
}

function verifySignature(signature, pubkey, asset, name) {
  const keyLines = base64(pubkey, "updater public key").toString("utf8").trimEnd().split(/\r?\n/u);
  const lines = base64(signature, `${name} signature`).toString("utf8").trimEnd().split(/\r?\n/u);
  requireCondition(keyLines.length === 2 && keyLines[0].startsWith("untrusted comment: "), "Invalid minisign public key");
  requireCondition(lines.length === 4 && lines[0].startsWith("untrusted comment: ") && lines[2].startsWith("trusted comment: "), `Invalid minisign signature for ${name}`);
  const key = base64(keyLines[1], "minisign public key packet");
  const packet = base64(lines[1], "minisign signature packet");
  const globalSignature = base64(lines[3], "minisign comment signature");
  requireCondition(key.length === 42 && key.subarray(0, 2).toString() === "Ed", "Invalid minisign public key packet");
  requireCondition(packet.length === 74 && globalSignature.length === 64, `Invalid minisign signature length for ${name}`);
  const algorithm = packet.subarray(0, 2).toString();
  requireCondition(algorithm === "ED" || algorithm === "Ed", `Unsupported minisign algorithm for ${name}`);
  requireCondition(key.subarray(2, 10).equals(packet.subarray(2, 10)), `Minisign key id mismatch for ${name}`);
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const bytes = algorithm === "ED" ? createHash("blake2b512").update(asset).digest() : asset;
  const detached = packet.subarray(10);
  requireCondition(verify(null, bytes, publicKey, detached), `Invalid asset signature for ${name}`);
  const comment = Buffer.from(lines[2].slice("trusted comment: ".length), "utf8");
  requireCondition(verify(null, Buffer.concat([detached, comment]), publicKey, globalSignature), `Invalid trusted comment signature for ${name}`);
}

export function verifyManifest(manifest, { config, workflow, assetsDir, tag }) {
  requireCondition(manifest.version === config.version, "The updater manifest version differs from the desktop version");
  if (tag) {
    requireCondition(manifest.version === tag.replace(/^v/u, ""), "The updater manifest version differs from the release tag");
  }
  requireCondition(typeof assetsDir === "string" && assetsDir.length > 0, "--assets needs a directory in manifest mode");
  requireCondition(statSync(assetsDir).isDirectory(), "--assets must be a directory");
  const platforms = manifest.platforms;
  requireCondition(
    platforms && typeof platforms === "object" && !Array.isArray(platforms),
    "The updater manifest has no platforms object",
  );
  const names = Object.keys(platforms);
  requireCondition(names.length > 0, "The updater manifest has no platforms");
  for (const name of updaterPlatforms(workflow)) {
    requireCondition(Object.hasOwn(platforms, name), `The updater manifest is missing platform ${name}`);
  }
  for (const name of names) {
    requireCondition(
      !/darwin|macos|apple/iu.test(name),
      `Unsigned macOS must not appear in the updater manifest: ${name}`,
    );
    const entry = platforms[name];
    requireCondition(
      typeof entry?.url === "string" &&
        (entry.url.startsWith("https://github.com/lucaswebsystems/openlimiter/") ||
          entry.url.startsWith("https://api.github.com/repos/lucaswebsystems/openlimiter/releases/assets/")),
      `Updater platform ${name} has an unreviewed URL`,
    );
    requireCondition(
      typeof entry?.signature === "string" && entry.signature.length > 0,
      `Updater platform ${name} has no signature`,
    );
    const filename = decodeURIComponent(new URL(entry.url).pathname.split("/").at(-1));
    requireCondition(filename && filename !== "." && filename !== ".." && !/[\\/]/u.test(filename) && basename(filename) === filename, `Invalid updater asset filename for ${name}`);
    const assetPath = resolve(assetsDir, filename);
    requireCondition(statSync(assetPath, { throwIfNoEntry: false })?.isFile(), `Updater asset does not exist: ${filename}`);
    verifySignature(entry.signature, config.plugins.updater.pubkey, readFileSync(assetPath), name);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // A release and the site ship together: the site must name the version this tag builds.
  const siteVersion = readFileSync(resolve(root, "apps/web/lib/site.ts"), "utf8").match(/CURRENT_VERSION = "([^"]+)"/u)?.[1];
  requireCondition(siteVersion === config.version, `apps/web/lib/site.ts says ${siteVersion}, the desktop app is ${config.version}`);
  const manifestIndex = process.argv.indexOf("--manifest");
  if (manifestIndex >= 0) {
    const manifestPath = process.argv[manifestIndex + 1];
    const assetsIndex = process.argv.indexOf("--assets");
    requireCondition(Boolean(manifestPath) && !manifestPath.startsWith("--"), "--manifest needs a path");
    const assetsDir = assetsIndex >= 0 ? process.argv[assetsIndex + 1] : undefined;
    verifyManifest(JSON.parse(readFileSync(resolve(manifestPath), "utf8")), {
      config,
      workflow: readFileSync(resolve(root, ".github/workflows/desktop-release.yml"), "utf8"),
      assetsDir,
      // RELEASE_TAG carries inputs.tag on manual runs, where GITHUB_REF_NAME is a branch.
      tag: process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME,
    });
  }

  // Local invocation checks configuration alone; CI builds also require release variables.
  if (process.env.GITHUB_ACTIONS === "true" && !process.argv.includes("--config-only")) {
    for (const name of [
      "OPENLIMITER_PRO_URL",
      "OPENLIMITER_SUPABASE_URL",
      "OPENLIMITER_SUPABASE_ANON_KEY",
    ]) {
      requireCondition(
        typeof process.env[name] === "string" && process.env[name].trim().length > 0,
        `${name} must be a nonempty release variable`,
      );
    }
  }

  console.log("Desktop release configuration verified");
}
