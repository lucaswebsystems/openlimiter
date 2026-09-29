import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { edgeSummary, renderEdge, startEdge } from "./edge-tab.js";

const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const nodes = Object.fromEntries(["attention", "accounts", "sessions", "attention-count", "status"].map(id => [id, {}]));
  const handlers = {};
  return { nodes, handlers, doc: { querySelector: id => nodes[id.slice(1)],
    addEventListener: (event, handler) => { handlers[event] = handler; },
    removeEventListener: event => { delete handlers[event]; } } };
}

test("attention comes from snapshot availability, pressure and agent flags", () => {
  assert.deepEqual(edgeSummary({ accounts: [], sessions: null }), { accounts: 0, sessions: 0, attention: 0 });
  const snapshot = { accounts: [
    { provider: "CODEX", account: "private fixture", availability: "available", value: 40, band: "green" },
    { availability: "missing_credentials", value: null },
    { availability: "available", band: "red", value: 95 },
    { availability: "unlimited", value: null },
  ], sessions: [{ state: "waiting" }, { state: "done", outcome: "failed" }, { state: "busy" }] };
  assert.deepEqual(edgeSummary(snapshot), { accounts: 2, sessions: 3, attention: 4 });
  const { doc, nodes } = fixture();
  renderEdge(doc, snapshot);
  assert.equal(nodes.attention.hidden, false);
  assert.equal(nodes.accounts.textContent, "2");
  assert.equal(nodes["attention-count"].textContent, "4");
  assert.ok(!JSON.stringify(nodes).includes("private fixture"));
  renderEdge(doc, {});
  assert.equal(nodes.attention.hidden, true);
});

test("snapshot requests serialize, Escape closes, teardown prevents late rendering", async () => {
  const { doc, nodes, handlers } = fixture();
  const calls = [];
  let resolve;
  const scheduled = [];
  const invoke = (command, args) => {
    calls.push([command, args]);
    return command.endsWith("rail_snapshot") ? new Promise(done => { resolve = done; }) : Promise.resolve();
  };
  const stop = startEdge(doc, invoke, callback => { scheduled.push(callback); return scheduled.length; }, () => {});
  handlers.visibilitychange();
  handlers.visibilitychange();
  assert.equal(calls.length, 1);
  resolve({ accounts: [], sessions: [] });
  await flush();
  assert.equal(scheduled.length, 1);
  handlers.keydown({ key: "Escape" });
  assert.equal(calls[1][0], "plugin:rail|rail_card_close");
  scheduled[0]();
  stop();
  resolve({ accounts: [], sessions: [{ state: "waiting" }] });
  await flush();
  assert.equal(nodes.attention.hidden, true);
  assert.equal(scheduled.length, 1);
  assert.deepEqual(handlers, {});
});

test("snapshot failure remains recoverable", async () => {
  const { doc, nodes } = fixture();
  let retry;
  let calls = 0;
  const stop = startEdge(doc, async () => {
    if (++calls === 1) throw Error("fixture failure");
    return {};
  }, next => { retry = next; }, () => {});
  await flush();
  assert.equal(nodes.status.textContent, "Local activity is unavailable.");
  await retry();
  assert.equal(nodes.status.textContent, "Current local activity");
  stop();
});

test("new surfaces use a local mark, CSP compatible module and bounded scrolling", () => {
  const tab = read("./edge-tab.html");
  const panel = read("./edge-panel.html");
  assert.match(tab, /brand\/openlimiter-mark.svg/);
  assert.doesNotMatch(tab, /<button|<h1|id="accounts"/);
  for (const html of [tab, panel]) {
    assert.match(html, /type="module" src="edge-tab.js"/);
    assert.doesNotMatch(html, /https?:\/\/|<script>/);
  }
  assert.match(read("./edge-tab.css"), /\.edge-panel\s*\{[^}]*height: 100%;[^}]*overflow: auto/s);
  for (const file of ["edge-tab.html", "edge-panel.html", "edge-tab.css", "edge-tab.js"]) {
    assert.ok(read("../scripts/build-ui.mjs").includes(`"${file}"`));
  }
});
