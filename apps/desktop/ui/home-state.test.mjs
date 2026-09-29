import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { homeProviders } from "./home-state.js";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("Home refreshes every provider in play, Cursor included, never a removed one", () => {
  const detections = { providers: [
    { provider_id: "cursor", state: "present" }, { provider_id: "gemini-cli", state: "installed_logged_out" },
  ] };
  const connections = [{ provider: "openrouter" }];
  const snapshots = [{ provider: "CLAUDE" }, { provider: "KIMI" }, { provider: "MUSE" }];
  assert.deepEqual(homeProviders(["CODEX"], detections, connections, snapshots, ["KIMI"]),
    ["CODEX", "CURSOR", "OPENROUTER", "CLAUDE"]);
});

test("Home keeps no second freshness policy and draws only through the shared projection", () => {
  const app = read("./app.js");
  const home = read("./home-state.js");
  assert.doesNotMatch(home, /REFRESH_SECONDS|expiresAt|observedAt|interval/u);
  assert.match(app, /projectReadings\(cacheRead\.ok \? cacheRead\.value : null, manualRead\.ok \? manualRead\.value : null, now\)/u);
  assert.match(app, /renderLimits\(document, elements\.rows, model\)/u);
  assert.match(app, /const attention = attentionFlags\(collected\.flags, collected\.snapshots, removed\);/u);
  assert.match(app, /showConnections\(\{\s*attention,\s*connected: connectedProviders\(/u);
  // A failed read ages out what is on screen by the same policy and says why.
  assert.match(app, /heldSnapshots = holdReadings\(heldSnapshots, now\);/u);
  assert.match(app, /elements\.refreshStatus\.textContent = say\("cacheUnreadable"\)/u);
  assert.doesNotMatch(app, /paintFailures\(\[\{ provider: "MANUAL"/u);
  assert.doesNotMatch(app, /createProviderRowElement|homeCard|homeSnapshots|stale-strip|staleStrip/u);
  // The panel reads the same projection, the same model and the same drawing.
  const panel = read("./edge-panel.js");
  for (const name of ["projectReadings", "limitsModel", "renderLimits", "agentsModel", "renderAgents"]) assert.match(panel, new RegExp(`\\b${name}\\(`, "u"));
});

test("Home's markup keeps Limits, then Agents, and no stale strip or table header", () => {
  const html = read("./index.html");
  const home = html.slice(html.indexOf('<section id="panel-meters"'), html.indexOf('id="panel-spend"'));
  assert.ok(home.indexOf('id="provider-rows"') < home.indexOf('id="agents-mount"'));
  assert.doesNotMatch(home, /stale-strip|home-provider-card|column-label/u);
  assert.match(html, /<link rel="stylesheet" href="\.\/quiet\.css" \/>/u);
  assert.match(html, /id="needs-attention"[\s\S]*id="attention-rows"/u);
});
