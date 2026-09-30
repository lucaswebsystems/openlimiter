import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { activityClient, agentsModel, AGENT_NAMES, mountAgents, renderAgents, runningLabel } from "./agents.js";
import { AGENTS_EN } from "./agents.en.js";
import { fakeDocument, leaks, spoken } from "./test-dom.mjs";

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const record = { sessionId: "opaque", agent: "claude_code", state: "waiting", firstObservedAt: "2026-09-28T12:00:00.000Z" };
const now = () => Date.parse("2026-09-28T12:02:05.000Z");
const preferences = { local: { enabled: true, quietHours: null, snoozedUntil: null, mutedProviders: [] }, sound: "silent" };
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("agents read as needs you, busy, done and failed, by tool name, and never as unknown", () => {
  const sessions = [
    { ...record, sessionId: "done", state: "done", firstObservedAt: "2026-09-28T11:00:00.000Z" },
    { ...record, sessionId: "busy", agent: "codex", state: "busy" },
    { ...record, sessionId: "idle", state: "idle" },
    { ...record, sessionId: "odd", state: "invented" },
    { ...record, sessionId: "wait" },
    { ...record, sessionId: "failed", agent: "gemini_cli", state: "unknown", outcome: "failed" },
    { ...record, sessionId: "stopped", state: "done", outcome: "cancelled" },
    { ...record, sessionId: "who", agent: "unknown", state: "busy", elapsedSeconds: 3_900 },
  ];
  const agents = agentsModel(sessions, now());
  assert.deepEqual(agents.map((agent) => [agent.id, agent.state, agent.label]), [
    ["wait", "waiting", "Needs you"], ["busy", "busy", "Busy"], ["who", "busy", "Busy"],
    ["done", "done", "Done"], ["stopped", "done", "Done"], ["failed", "failed", "Failed"],
  ]);
  assert.deepEqual(agents.map((agent) => agent.name), ["Claude Code", "Codex", "Agent", "Claude Code", "Claude Code", "Gemini CLI"]);
  assert.deepEqual(agents.map((agent) => agent.time), ["2m", "2m", "1h 5m", "1h 2m", "2m", "2m"]);
  assert.equal(agentsModel(null), null);
  assert.equal(agentsModel([{ ...record, firstObservedAt: "bad" }], now())[0].time, "");
  assert.deepEqual(leaks(agents.flatMap((agent) => [agent.name, agent.label, agent.time])), []);
});

test("the running line counts agents at work or waiting", () => {
  assert.equal(runningLabel([]), "No agents running");
  assert.equal(runningLabel(agentsModel([record], now())), "1 agent running");
  assert.equal(runningLabel(agentsModel([record, { ...record, sessionId: "b", state: "busy" }, { ...record, sessionId: "c", state: "done" }], now())), "2 agents running");
  assert.equal(runningLabel(null), "Agent activity is unavailable");
  assert.equal(AGENT_NAMES.claude_code, "Claude Code");
});

test("activity client only reads sanitized commands and explicitly locates by opaque id", async () => {
  const calls = []; const client = activityClient(async (...args) => calls.push(args));
  await client.sessions(); await client.preferences(); await client.locate("opaque"); await client.savePreferences(preferences);
  assert.deepEqual(calls.map(([cmd]) => cmd), ["plugin:activity|activity_sessions", "plugin:activity|activity_notification_preferences", "plugin:activity|activity_locate", "plugin:activity|activity_set_notification_preferences"]);
  assert.deepEqual(calls[2][1], { sessionId: "opaque" });
  await assert.rejects(activityClient(null).sessions());
});

test("only a waiting agent offers Show app, and it locates that session", async () => {
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  const located = [];
  renderAgents(doc, mount, agentsModel([record, { ...record, sessionId: "b", state: "busy" }], now()),
    { locate: (id) => located.push(id), markFor: () => "<svg></svg>" });
  const buttons = mount.all((node) => node.localName === "button");
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].textContent, "Show app");
  await buttons[0].fire("click");
  assert.deepEqual(located, ["opaque"]);
  assert.deepEqual(mount.all((node) => node.className === "q-mark").map((mark) => mark.dataset.provider), ["CLAUDE", "CLAUDE"]);
});

test("mount renders safely, locates only on click, and saves free preferences", async () => {
  const doc = fakeDocument(); const root = doc.createElement("div"); const calls = []; let saved;
  const dispose = mountAgents(root, { now, interval: 100_000, client: {
    sessions: async () => [{ ...record, userProjectLabel: "<img src=x>", process: { pid: 42 } }],
    preferences: async () => structuredClone(preferences),
    locate: async (id) => { calls.push(id); return "flashed"; },
    savePreferences: async (value) => { saved = value; },
  } });
  try {
    await settle();
    assert.equal(root.all((node) => node.className === "q-agent").length, 1);
    assert.equal(root.all((node) => node.localName === "img").length, 0);
    assert.deepEqual(calls, []);
    await root.all((node) => node.className === "q-show")[0].fire("click");
    assert.deepEqual(calls, ["opaque"]);
    assert.equal(root.all((node) => node.className === "q-note")[0].textContent, "App highlighted in the taskbar");
    assert.equal(root.all((node) => node.localName === "summary")[0].textContent, AGENTS_EN["agents.alerts"]);
    await root.all((node) => node.localName === "form")[0].fire("submit", { preventDefault() {} });
    assert.equal(saved.sound, "silent"); assert.deepEqual(saved.local.mutedProviders, []);
    assert.equal(saved.local.quietHours, null); assert.equal(saved.local.enabled, true);
    assert.deepEqual(leaks(spoken(root)), []);
  } finally { dispose(); }
  assert.equal(root.children.length, 0);
});

test("empty, unavailable and recovered are distinct and late reads cannot remount", async () => {
  const empty = (root) => root.all((node) => node.className === "q-empty")[0];
  for (const [sessions, check] of [
    [async () => [], (root) => assert.equal(empty(root).hidden, false)],
    [async () => { throw Error(); }, (root) => assert.equal(root.all((node) => node.className === "q-note")[0].textContent, "Agent activity is unavailable")],
  ]) {
    const doc = fakeDocument(); const root = doc.createElement("div");
    const dispose = mountAgents(root, { client: { sessions, preferences: async () => { throw Error(); } } });
    await settle(); check(root); dispose();
  }
  let resolve; const doc = fakeDocument(); const root = doc.createElement("div");
  const dispose = mountAgents(root, { client: { sessions: () => new Promise((r) => { resolve = r; }), preferences: async () => preferences } });
  dispose(); resolve([record]); await settle(); assert.equal(root.children.length, 0);
});

test("desktop shell mounts the Agents component inside Home and disposes on unload", async () => {
  const html = read("./index.html");
  assert.match(html, /href="\.\/agents.css"/);
  const homeStart = html.indexOf('<section id="panel-meters"');
  const hostStart = html.indexOf('<div id="agents-mount">');
  assert.ok(homeStart < hostStart && hostStart < html.indexOf('id="panel-spend"', homeStart));
  const app = read("./app.js");
  assert.match(app, /import \{ mountAgents \} from "\.\/agents.js"/);
  const wiring = app.match(/const disposeAgents = mountAgents\(elements.agentsMount, \{ markFor: officialMark \}\);\s*window.addEventListener\("beforeunload", disposeAgents, \{ once: true \}\);/);
  assert.ok(wiring);
  assert.match(html, /<h2 id="agents-title">Agents<\/h2>/);
  const host = fakeDocument().createElement("div");
  let dispose;
  runInNewContext(wiring[0], {
    elements: { agentsMount: host },
    officialMark: () => "",
    mountAgents: (target, options) => mountAgents(target, { ...options, now, client: {
      sessions: async () => [record],
      preferences: async () => { throw new Error("unavailable"); },
    } }),
    window: { addEventListener: (event, callback) => { assert.equal(event, "beforeunload"); dispose = callback; } },
  });
  try {
    await settle();
    assert.match(host.textContent, /Claude Code/);
    assert.match(host.textContent, /Needs you/);
    assert.match(host.textContent, /Show app/);
  } finally { dispose(); }
  assert.equal(host.children.length, 0);
});

test("the built Home includes the Agents component and its local dependencies", () => {
  for (const file of ["agents.js", "agents.css"]) {
    assert.equal(read(`./dist/${file}`), read(`./${file}`), `${file} must be packaged by build-ui`);
  }
  // The catalog ships as a JavaScript module: the desktop CSP blocks JSON
  // module imports (connect-src), so build-ui converts the JSON and rewrites
  // the import in agents.en.js.
  assert.match(read("./dist/agents.en.json.js"), /^export default /);
  assert.match(read("./dist/agents.en.js"), /agents\.en\.json\.js/);
});

test("catalog prose has no dashes and includes toast and locate results", () => {
  for (const value of Object.values(AGENTS_EN)) assert.doesNotMatch(value, /[-–—]/u);
  assert.equal(AGENTS_EN["agents.toast.waiting"], "{agent} needs you");
  assert.equal(AGENTS_EN["agents.toast.done"], "{agent} finished");
});
