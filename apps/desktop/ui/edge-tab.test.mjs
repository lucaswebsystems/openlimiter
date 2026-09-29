import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { edgeSummary, followTheme, renderEdge, startEdge } from "./edge-tab.js";

const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const classes = new Set();
  const tab = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
    classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); } } };
  const nodes = { attention: {}, ".edge-tab": tab };
  const handlers = {};
  return { nodes, handlers, classes, tab, doc: { querySelector: id => nodes[id.startsWith("#") ? id.slice(1) : id],
    addEventListener: (event, handler) => { handlers[event] = handler; },
    removeEventListener: event => { delete handlers[event]; } } };
}

test("the pill shows for a limit at 80 percent or an agent waiting, and never an identifier", () => {
  assert.deepEqual(edgeSummary({ accounts: [], sessions: null }), { accounts: 0, sessions: 0, attention: 0 });
  const snapshot = { accounts: [
    { provider: "CODEX", account: "private fixture", availability: "available", value: 40, band: "green" },
    { availability: "missing_credentials", value: null },
    { availability: "available", band: "red", value: 95 },
    { availability: "unlimited", value: null },
  ], sessions: [{ state: "waiting" }, { state: "done", outcome: "failed" }, { state: "busy" }],
  window: { cardOpen: true } };
  assert.deepEqual(edgeSummary(snapshot), { accounts: 2, sessions: 3, attention: 4 });
  const { doc, nodes, classes, tab } = fixture();
  renderEdge(doc, snapshot);
  assert.equal(nodes.attention.hidden, false);
  assert.ok(classes.has("open"), "an open panel lifts the tab");
  assert.equal(tab.attributes["aria-label"], "OpenLimiter, Needs attention");
  assert.ok(!JSON.stringify(tab).includes("private fixture"));
  renderEdge(doc, {});
  assert.equal(nodes.attention.hidden, true);
  assert.ok(!classes.has("open"));
  assert.equal(tab.attributes["aria-label"], "OpenLimiter");
});

test("snapshot requests serialize and teardown prevents late rendering", async () => {
  const { doc, nodes, handlers } = fixture();
  const calls = [];
  let resolve;
  const scheduled = [];
  const invoke = (command, args) => {
    calls.push([command, args]);
    return new Promise(done => { resolve = done; });
  };
  const stop = startEdge(doc, invoke, callback => { scheduled.push(callback); return scheduled.length; }, () => {});
  handlers.visibilitychange();
  handlers.visibilitychange();
  assert.equal(calls.length, 1);
  resolve({ accounts: [], sessions: [] });
  await flush();
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  stop();
  resolve({ accounts: [], sessions: [{ state: "waiting" }] });
  await flush();
  assert.equal(nodes.attention.hidden, true);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(handlers, {});
});

test("snapshot failure keeps the last state and recovers", async () => {
  const { doc, nodes } = fixture();
  let retry;
  let calls = 0;
  const stop = startEdge(doc, async () => {
    if (++calls === 1) throw Error("fixture failure");
    return { sessions: [{ state: "waiting" }] };
  }, next => { retry = next; }, () => {});
  await flush();
  assert.equal(nodes.attention.hidden, undefined);
  await retry();
  assert.equal(nodes.attention.hidden, false);
  stop();
});

test("a saved theme wins, otherwise the system scheme", () => {
  const listeners = {};
  const store = new Map();
  const media = { matches: true, addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: () => {} };
  const win = { matchMedia: () => media, localStorage: { getItem: key => store.get(key) ?? null },
    addEventListener: () => {}, removeEventListener: () => {} };
  const doc = { documentElement: { dataset: {} } };
  const stop = followTheme(doc, win);
  assert.equal(doc.documentElement.dataset.theme, "light");
  store.set("openlimiter-theme", "dark");
  listeners.change();
  assert.equal(doc.documentElement.dataset.theme, "dark");
  stop();
});

test("the tab and the panel are local, CSP compatible documents drawn from tokens", () => {
  const tab = read("./edge-tab.html");
  const panel = read("./edge-panel.html");
  assert.match(tab, /brand\/openlimiter-mark.svg/);
  assert.doesNotMatch(tab, /<button|<h1|id="accounts"/);
  assert.match(tab, /type="module" src="edge-tab.js"/);
  assert.match(panel, /type="module" src="edge-panel.js"/);
  for (const html of [tab, panel]) {
    assert.match(html, /href="\.\/engine\/ui\/tokens\.css"/);
    assert.doesNotMatch(html, /https?:\/\/|<script>/);
  }
  for (const css of [read("./edge-tab.css"), read("./edge-panel.css"), read("./quiet.css")]) {
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/iu, "colours come from tokens");
  }
  assert.match(read("./edge-panel.css"), /\.p-scroll\s*\{[^}]*overflow-y: auto/s);
  for (const file of ["edge-tab.html", "edge-panel.html", "edge-tab.css", "edge-tab.js", "edge-panel.css", "edge-panel.js", "readings.js", "names.js", "quiet.css"]) {
    assert.ok(read("../scripts/build-ui.mjs").includes(`"${file}"`), file);
  }
});
