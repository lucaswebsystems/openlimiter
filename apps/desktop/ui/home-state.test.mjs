import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as homeState from "./home-state.js";

const { homeProviders } = homeState;
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

test("the account is offered under the first bar of a fresh install, once, and never to a signed in person", () => {
  const { accountOfferShown } = homeState;
  assert.equal(typeof accountOfferShown, "function", "no rule for the account offer");
  const shown = (change) => accountOfferShown({ offer: "pending", accountKnown: true, signedIn: false, hasBars: true, ...change });
  assert.equal(shown({}), true);
  assert.equal(shown({ hasBars: false }), false, "offered before the first bar");
  assert.equal(shown({ accountKnown: false }), false, "offered before the account answered");
  assert.equal(shown({ signedIn: true }), false, "offered to a signed in person");
  for (const offer of [null, "dismissed", "done"]) assert.equal(shown({ offer }), false, String(offer));
});

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
  // One list, from the inventory, drawn by the same renderer the panel uses.
  assert.match(app, /const model = inventoryModel\(\{\s*snapshots,\s*flags: inventory\.flags,/u);
  /* Usage rows carry the same handlers as Connect Tools: a signed out tool
     keeps its row there with its one action. */
  assert.match(app, /renderLimits\(document, elements\.usageRows, usage, \{ handlers: toolHandlers \}\)/u);
  assert.match(app, /renderLimits\(document, elements\.toolRows, tools, \{ handlers: toolHandlers, more: fillMore, opened: openMenus \}\)/u);
  assert.doesNotMatch(app, /showConnections|connectedProviders|attentionFlags\(/u);
  // A failed read ages out what is on screen by the same policy and says why.
  assert.match(app, /heldSnapshots = holdReadings\(heldSnapshots, now, claudePoll === true\);/u);
  // The Claude request switch is read before the cache, so every row drawn is validated against it as it stands now.
  const switchRead = app.indexOf("await claudePollEnabled()");
  assert.ok(switchRead !== -1 && switchRead < app.indexOf("collect(now), listDetectedProviders()"), "the switch is read first");
  assert.match(app, /elements\.refreshStatus\.textContent = say\("cacheUnreadable"\)/u);
  assert.doesNotMatch(app, /paintFailures\(\[\{ provider: "MANUAL"/u);
  assert.doesNotMatch(app, /createProviderRowElement|homeCard|homeSnapshots|stale-strip|staleStrip/u);
  // The panel reads the same projection, the same model and the same drawing.
  const panel = read("./edge-panel.js");
  for (const name of ["projectReadings", "limitsModel", "renderLimits", "agentsModel", "renderAgents"]) assert.match(panel, new RegExp(`\\b${name}\\(`, "u"));
});

test("the one screen reads Tools, then API keys, then Agents, and no stale strip or table header", () => {
  const html = read("./index.html");
  const usage = html.slice(html.indexOf('id="tab-panel-usage"'), html.indexOf('id="tab-panel-tools"'));
  const tools = html.slice(html.indexOf('id="tab-panel-tools"'), html.indexOf('id="tab-panel-settings"'));
  assert.ok(usage.indexOf('id="usage-rows"') < usage.indexOf('id="agents-mount"'));
  const order = ['id="tool-rows"', 'id="add-tool"', 'id="tool-catalogue"', 'id="key-rows"'].map((id) => tools.indexOf(id));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1])), order.join());
  assert.doesNotMatch(html, /stale-strip|home-provider-card|column-label|needs-attention|connected-rows/u);
  assert.match(html, /<link rel="stylesheet" href="\.\/quiet\.css" \/>/u);
});
