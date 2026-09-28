import test from "node:test";
import assert from "node:assert/strict";
import { activityClient, agentRow, mountAgents } from "./agents.js";
import { AGENTS_EN } from "./agents.en.js";

const record = { sessionId: "opaque", agent: "claude_code", state: "waiting", firstObservedAt: "2026-09-28T12:00:00.000Z" };
const now = () => Date.parse("2026-09-28T12:02:05.000Z");
const preferences = { local: { enabled: true, quietHours: null, snoozedUntil: null, mutedProviders: [] }, sound: "silent" };

test("agent rows use words and distinct shapes, computer and elapsed time", () => {
  const shapes = new Set();
  for (const state of ["busy", "waiting", "done", "idle", "unknown"]) {
    const row = agentRow({ ...record, state }, now());
    assert.equal(row.label, AGENTS_EN[`agents.state.${state}`]); shapes.add(row.shape);
    assert.equal(row.computer, "This computer"); assert.equal(row.elapsed, "2:05 elapsed");
    assert.equal(row.name, "Claude");
  }
  assert.equal(shapes.size, 5);
  assert.equal(agentRow({ ...record, state: "invented" }, now()).label, "Unknown");
  assert.equal(agentRow({ ...record, firstObservedAt: "bad" }, now()).elapsed, "Elapsed time unknown");
  assert.equal(agentRow(record, 0).elapsed, "0:00 elapsed");
  assert.equal(agentRow({ ...record, state: "unknown", outcome: "failed" }, now()).label, "Unknown (Failed)");
  assert.equal(agentRow({ ...record, agent: "constructor" }, now()).name, "Agent");
});

test("activity client only reads sanitized commands and explicitly locates by opaque id", async () => {
  const calls = []; const client = activityClient(async (...args) => calls.push(args));
  await client.sessions(); await client.preferences(); await client.locate("opaque"); await client.savePreferences(preferences);
  assert.deepEqual(calls.map(([cmd]) => cmd), ["plugin:activity|activity_sessions", "plugin:activity|activity_notification_preferences", "plugin:activity|activity_locate", "plugin:activity|activity_set_notification_preferences"]);
  assert.deepEqual(calls[2][1], { sessionId: "opaque" });
  await assert.rejects(activityClient(null).sessions());
});

class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ""; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  remove() { this.parent.children = this.parent.children.filter((node) => node !== this); }
  all(tag) { return this.children.flatMap((node) => [...(node.tagName === tag ? [node] : []), ...node.all(tag)]); }
}
function host() { const doc = { createElement: (tag) => new Element(tag, doc) }; return new Element("div", doc); }
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("mount renders safely, locates only on click, and saves free preferences", async () => {
  const root = host(); const calls = []; let saved;
  const dispose = mountAgents(root, { now, interval: 100_000, client: {
    sessions: async () => [{ ...record, userProjectLabel: "<img src=x>", process: { pid: 42 } }],
    preferences: async () => structuredClone(preferences),
    locate: async (id) => { calls.push(id); return "flashed"; },
    savePreferences: async (value) => { saved = value; },
  } });
  try {
    await settle(); assert.equal(root.all("li").length, 1); assert.deepEqual(calls, []);
    assert.equal(root.all("img").length, 0);
    await root.all("button")[0].listeners.click(); assert.deepEqual(calls, ["opaque"]);
    assert.equal(root.all("p")[0].textContent, "App highlighted in the taskbar");
    await root.all("form")[0].listeners.submit({ preventDefault() {} });
    assert.equal(saved.sound, "silent"); assert.deepEqual(saved.local.mutedProviders, []);
    assert.equal(saved.local.quietHours, null); assert.equal(saved.local.enabled, true);
  } finally { dispose(); }
  assert.equal(root.children.length, 0);
});

test("empty, unavailable and unknown are distinct and late reads cannot remount", async () => {
  for (const [sessions, expected] of [[async () => [], "No live agent sessions"], [async () => { throw Error(); }, "Agent activity is unavailable"]]) {
    const root = host(); const dispose = mountAgents(root, { client: { sessions, preferences: async () => { throw Error(); } } });
    await settle(); assert.equal(root.all("p")[0].textContent, expected); dispose();
  }
  let resolve; const root = host();
  const dispose = mountAgents(root, { client: { sessions: () => new Promise((r) => { resolve = r; }), preferences: async () => preferences } });
  dispose(); resolve([record]); await settle(); assert.equal(root.children.length, 0);
});

test("catalog prose has no dashes and includes toast and locate results", () => {
  for (const value of Object.values(AGENTS_EN)) assert.doesNotMatch(value, /[-–—]/u);
  assert.equal(AGENTS_EN["agents.toast.waiting"], "{agent} needs you");
  assert.equal(AGENTS_EN["agents.toast.done"], "{agent} finished");
});
