import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const manifestIndex = process.argv.indexOf("--manifest");
if (manifestIndex >= 0) {
  const manifestPath = process.argv[manifestIndex + 1];
  requireCondition(Boolean(manifestPath), "--manifest needs a path");
  const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  const platforms = manifest.platforms;
  requireCondition(
    platforms && typeof platforms === "object" && !Array.isArray(platforms),
    "The updater manifest has no platforms object",
  );
  const names = Object.keys(platforms);
  requireCondition(names.length > 0, "The updater manifest has no platforms");
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
  }
}

if (!process.argv.includes("--config-only")) {
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
