// Manual measurement after pnpm build: node packages/cli/test/activity-benchmark.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const directory = await mkdtemp(path.join(tmpdir(), "openlimiter-activity-benchmark-"));
const state = process.platform === "darwin"
  ? path.join(directory, "Library", "Application Support", "openlimiter")
  : path.join(directory, "openlimiter");
const spool = path.join(state, "activity");
const stamp = path.join(spool, ".acl-verified");
const payload = JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "timing", prompt: "private" });
const events = async () => {
  try { return (await readdir(spool)).filter((name) => name.endsWith(".json")).length; }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
};
async function measure() {
  const before = await events();
  const start = performance.now();
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)), "event", "--agent", "codex", "--event", "UserPromptSubmit"], {
    input: payload, encoding: "utf8", timeout: 40_000, windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: directory, APPDATA: directory,
      XDG_STATE_HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory,
      XDG_DATA_HOME: directory, XDG_RUNTIME_DIR: directory, HOME: directory, USERPROFILE: directory }
  });
  return {
    ms: +(performance.now() - start).toFixed(2), exitCode: result.status,
    silent: result.stdout === "" && result.stderr === "", error: result.error?.code ?? null,
    eventWritten: await events() === before + 1
  };
}
try {
  const cold = [];
  for (let index = 0; index < 3; index++) {
    await unlink(stamp).catch((error) => { if (error.code !== "ENOENT") throw error; });
    cold.push(await measure());
  }
  const warm = [];
  if (cold.every((run) => run.eventWritten)) {
    for (let index = 0; index < 20; index++) warm.push(await measure());
  }
  const sorted = warm.map((run) => run.ms).sort((left, right) => left - right);
  const percentile = (fraction) => sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * fraction) - 1];
  console.log(JSON.stringify({ cold, warm, p50: percentile(0.5), p95: percentile(0.95), eventsWritten: await events() }, null, 2));
  assert.equal(warm.length, 20, "Cold event writes failed; a verified warm path cannot be measured");
  assert.ok([...cold, ...warm].every((run) => run.exitCode === 0 && run.silent && run.error === null && run.eventWritten), "Every timed invocation must silently publish one event");
  assert.ok(sorted.every((ms) => ms < 150), "Warm event wall time must be under 150 ms");
} finally {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("openlimiter-activity-benchmark-")) throw new Error("Unsafe benchmark cleanup");
  await rm(resolved, { recursive: true, force: true });
}
