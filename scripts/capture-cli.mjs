/**
 * Recapture the command line output the documentation pastes in.
 *
 * Seeds a scratch state directory from the project's own synthetic fixtures,
 * runs the commands, and prints each capture with a banner. Nothing here reads
 * a real account or a real credential: every value comes from
 * packages/connectors fixtures, and the scratch directory is thrown away by the
 * operating system.
 *
 * Usage, from the repository root, after `pnpm build`:
 *
 *   node scripts/capture-cli.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const binary = path.join(root, "packages", "cli", "dist", "bin.js");
const fixtures = await import(
  pathToFileURL(path.join(root, "packages", "connectors", "dist", "fixtures.js")).href
);

const scratch = mkdtempSync(path.join(tmpdir(), "openlimiter-capture-"));

/** The state directory the CLI resolves for each platform, pointed at scratch. */
const stateEnvironment = process.platform === "win32"
  ? { LOCALAPPDATA: scratch }
  : process.platform === "darwin"
    ? { HOME: scratch }
    : { XDG_STATE_HOME: scratch };

function run(argumentsList, environment = {}) {
  return execFileSync(process.execPath, [binary, ...argumentsList], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...stateEnvironment, ...environment }
  }).replace(/\r?\n$/u, "");
}

function banner(title, command) {
  console.log("\n=== " + title + " ===");
  console.log("$ " + command);
}

const now = new Date().toISOString();
const payloads = [
  ["claude", fixtures.claudeFixture(now)],
  ["openrouter", fixtures.openrouterFixture()],
  ["codex", fixtures.codexFixture(now)],
  ["antigravity", fixtures.antigravityFixture(now)],
  ["opencode", fixtures.opencodeFixture(now)],
  ["manual", fixtures.manualFixture(now)]
];

try {
  for (const [provider, payload] of payloads) {
    run(["ingest", "--provider", provider, "--payload", JSON.stringify(payload)]);
  }

  banner("demo", "NO_COLOR=1 node packages/cli/dist/bin.js demo");
  console.log(run(["demo"], { NO_COLOR: "1" }));

  banner("statusline, default layout", "node packages/cli/dist/bin.js statusline");
  console.log(run(["statusline"], { NO_COLOR: "1" }));

  banner(
    "statusline, one row at width 200",
    "openlimiter config set statusline.width 200 && node packages/cli/dist/bin.js statusline"
  );
  run(["config", "set", "statusline.width", "200"]);
  console.log(run(["statusline"], { NO_COLOR: "1" }));
  run(["config", "set", "statusline.width", "140"]);

  banner(
    "statusline, one narrow row",
    "openlimiter config set statusline.rows 1 && openlimiter config set " +
    "statusline.width 100 && node packages/cli/dist/bin.js statusline"
  );
  run(["config", "set", "statusline.rows", "1"]);
  run(["config", "set", "statusline.width", "100"]);
  console.log(run(["statusline"], { NO_COLOR: "1" }));
  run(["config", "set", "statusline.rows", "2"]);
  run(["config", "set", "statusline.width", "140"]);

  banner(
    "statusline, every meter",
    "openlimiter config set statusline.meters all && node packages/cli/dist/bin.js statusline"
  );
  run(["config", "set", "statusline.meters", "all"]);
  console.log(run(["statusline"], { NO_COLOR: "1" }));
  run(["config", "set", "statusline.meters", "worst"]);

  banner(
    "statusline, the 0.1.0 line",
    "openlimiter config set statusline.bars false && node packages/cli/dist/bin.js statusline"
  );
  run(["config", "set", "statusline.bars", "false"]);
  console.log(run(["statusline"], { NO_COLOR: "1" }));
  run(["config", "set", "statusline.bars", "true"]);

  banner(
    "statusline in colour",
    "openlimiter config set statusline.color always && node packages/cli/dist/bin.js statusline"
  );
  console.log(run(["config", "set", "statusline.color", "always"]));
  console.log(run(["statusline"]));
  run(["config", "set", "statusline.color", "auto"]);

  banner("config get", "openlimiter config get statusline");
  console.log(run(["config", "get", "statusline"]));

  banner("hook", "node packages/cli/dist/bin.js hook");
  console.log(run(["hook"]));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
