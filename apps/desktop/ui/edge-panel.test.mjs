import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { messyFixtures } from "./messy-fixtures.mjs";
import { fakeDocument, leaks, spoken } from "./test-dom.mjs";
// The panel reaches the compiled engine, which only exists in the build.
import { naturalHeight, openMainWindow, PANEL_SHOWN_EVENT, startPanel } from "./dist/edge-panel.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const IDS = ["panel-card", "panel-scroll", "panel-updated", "panel-agents", "panel-agent-rows", "panel-note", "panel-limits",
  "panel-state", "panel-state-title", "panel-state-detail", "panel-running", "panel-running-text", "panel-open"];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function panel({ cache, sessions = [], windows, event, content = 300 } = {}) {
  const fixtures = messyFixtures(NOW);
  const doc = fakeDocument(IDS);
  // The card sits 12 pixels in, is 400 tall, and shows 300 of the scroller.
  Object.assign(doc.getElementById("panel-card"), { offsetTop: 12, offsetHeight: 400 });
  Object.assign(doc.getElementById("panel-scroll"), { clientHeight: 300, scrollHeight: content });
  const calls = [];
  const scheduled = [];
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === "read_cache") {
      if (cache === "fail") throw new Error("fixture failure");
      return JSON.stringify(cache ?? fixtures.projected);
    }
    if (command === "read_manual") return "";
    if (command === "plugin:rail|rail_snapshot") return { accounts: [], flags: [], sessions };
    if (command === "plugin:activity|activity_locate") return "focused";
    return null;
  };
  const stop = startPanel(doc, { core: { invoke }, window: windows, event }, {
    now: () => new Date(NOW).toISOString(), schedule: (callback) => { scheduled.push(callback); return scheduled.length; }, cancel: () => {},
  });
  return { doc, calls, scheduled, stop, fixtures, view: (id) => doc.getElementById(id) };
}

test("the panel draws Home's projection in its column form, tightest first", async () => {
  const { view, stop } = panel();
  await flush();
  const cards = view("panel-limits").all((node) => "providerCard" in node.dataset);
  assert.deepEqual(cards.map((card) => card.dataset.provider), ["CODEX", "CLAUDE", "OPENROUTER"]);
  assert.equal(view("panel-limits").hidden, false);
  assert.equal(view("panel-state").hidden, true);
  assert.equal(view("panel-updated").textContent, "Updated 2 min ago");
  assert.equal(view("panel-agents").hidden, true);
  assert.equal(view("panel-running-text").textContent, "No agents running");
  assert.deepEqual(leaks(spoken(view("panel-limits"))), []);
  assert.doesNotMatch(view("panel-limits").textContent, /Kimi|Antigravity/u);
  stop();
});

test("agents show needs you first with Show app, and the footer counts the running ones", async () => {
  const { view, calls, stop, fixtures } = panel({ sessions: messyFixtures(NOW).sessions });
  await flush();
  const rows = view("panel-agent-rows").all((node) => node.className === "q-agent");
  assert.deepEqual(rows.map((row) => row.dataset.state), ["waiting", "busy", "done"]);
  assert.equal(view("panel-agents").hidden, false);
  assert.equal(view("panel-running-text").textContent, "2 agents running");
  assert.equal(view("panel-running").getAttribute("data-live"), "");
  const show = view("panel-agent-rows").all((node) => node.localName === "button");
  assert.equal(show.length, 1);
  await show[0].fire("click");
  assert.deepEqual(calls.at(-1), ["plugin:activity|activity_locate", { sessionId: fixtures.sessions[0].sessionId }]);
  assert.equal(view("panel-note").textContent, "App brought forward");
  assert.deepEqual(leaks(spoken(view("panel-agents"))), []);
  stop();
});

test("honest states: loading, nothing measurable yet, and unavailable", async () => {
  const empty = panel({ cache: { version: 2, snapshots: [], flags: [] } });
  assert.equal(empty.view("panel-state").hidden, false, "loading shows until the first read answers");
  await flush();
  assert.equal(empty.view("panel-state-title").textContent, "Nothing measurable yet");
  assert.equal(empty.view("panel-state-detail").textContent, "Open the app to connect a tool.");
  assert.equal(empty.view("panel-limits").hidden, true);
  empty.stop();
  const broken = panel({ cache: "fail" });
  await flush();
  assert.equal(broken.view("panel-state-title").textContent, "Your limits are unavailable right now.");
  assert.equal(broken.view("panel-updated").textContent, "");
  broken.stop();
});

test("Open app brings the main window forward and closes the panel; Escape closes it", async () => {
  const steps = [];
  const main = { show: async () => steps.push("show"), unminimize: async () => steps.push("unminimize"), setFocus: async () => steps.push("focus") };
  const windows = { Window: { getByLabel: async (label) => (steps.push(label), main) } };
  const { view, doc, calls, stop } = panel({ windows });
  await flush();
  await view("panel-open").fire("click");
  assert.deepEqual(steps, ["main", "show", "unminimize", "focus"]);
  assert.equal(calls.at(-1)[0], "plugin:rail|rail_card_close");
  await doc.fire("keydown", { key: "Escape" });
  assert.equal(calls.filter(([command]) => command === "plugin:rail|rail_card_close").length, 2);
  assert.equal(await openMainWindow({}), false);
  stop();
});

test("polls serialize and nothing is redrawn when nothing changed", async () => {
  const { view, scheduled, calls, stop } = panel();
  await flush();
  const first = view("panel-limits").children;
  await scheduled[0]();
  assert.equal(view("panel-limits").children, first, "the same nodes, so focus survives a poll");
  assert.equal(calls.filter(([command]) => command === "read_cache").length, 2);
  stop();
  await flush();
  assert.equal(scheduled.length, 2);
});

test("the panel reports the height its content needs, and only when it changes", async () => {
  assert.equal(naturalHeight({ offsetTop: 12, offsetHeight: 400 }, { clientHeight: 300, scrollHeight: 520 }), 644);
  assert.equal(naturalHeight({ offsetTop: 0, offsetHeight: 480 }, { clientHeight: 380, scrollHeight: 200 }), 300);
  const { calls, scheduled, doc, stop } = panel({ content: 520 });
  await flush();
  const reports = () => calls.filter(([command]) => command === "plugin:rail|rail_card_height").map(([, args]) => args.height);
  assert.deepEqual(reports(), [644]);
  await scheduled.at(-1)();
  assert.deepEqual(reports(), [644], "an unchanged height is not sent again");
  doc.getElementById("panel-scroll").scrollHeight = 250;
  await scheduled.at(-1)();
  assert.deepEqual(reports(), [644, 374]);
  stop();
});

test("the panel reads once at start, polls only while shown, and stops when hidden", async () => {
  const listeners = {};
  let unlistened = 0;
  const event = { listen: async (name, handler) => { listeners[name] = handler; return () => { unlistened++; }; } };
  const { calls, scheduled, stop } = panel({ event });
  await flush();
  const reads = () => calls.filter(([command]) => command === "read_cache").length;
  assert.equal(reads(), 1, "the first draw sizes the panel before it is ever shown");
  assert.equal(scheduled.length, 0, "a hidden panel does not poll");
  listeners[PANEL_SHOWN_EVENT]({ payload: true });
  await flush();
  assert.equal(reads(), 2, "opening reads at once");
  assert.equal(scheduled.length, 1, "and keeps reading while shown");
  await scheduled[0]();
  assert.equal(reads(), 3);
  listeners[PANEL_SHOWN_EVENT]({ payload: false });
  await flush();
  const before = scheduled.length;
  await scheduled.at(-1)();
  assert.equal(scheduled.length, before, "hidden: the poll that was due does not schedule another");
  stop();
  assert.equal(unlistened, 1);
});

test("the panel window may invoke only what its capability grants", () => {
  const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  const granted = new Set();
  for (const file of ["rail.json", "activity.json", "edge-panel.json"]) {
    for (const capability of [read(`../src-tauri/capabilities/${file}`)].flat()) {
      if (capability.windows.includes("rail-card")) capability.permissions.forEach((permission) => granted.add(permission));
    }
  }
  for (const permission of ["rail:default", "activity:allow-activity-locate", "core:window:allow-get-all-windows",
    "core:window:allow-show", "core:window:allow-unminimize", "core:window:allow-set-focus",
    "rail:allow-rail-card-height", "core:event:allow-listen", "core:event:allow-unlisten"]) {
    assert.ok(granted.has(permission), permission);
  }
  const edge = read("../src-tauri/capabilities/edge-panel.json");
  assert.deepEqual(edge.windows, ["rail-card"]);
  assert.equal(edge.permissions.length, 7, "Open app, its own height and its shown state; nothing else");
  // The height command is the panel's alone: not part of rail:default, which main and the tab also hold.
  const railDefault = readFileSync(new URL("../src-tauri/permissions/rail/default.toml", import.meta.url), "utf8");
  assert.doesNotMatch(railDefault, /rail-card-height/u);
  assert.match(readFileSync(new URL("../src-tauri/build_support/rail.rs", import.meta.url), "utf8"), /"rail_card_height"/u);
});
