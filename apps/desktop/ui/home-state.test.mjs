import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildProviderAccountRows, providerRowMarkup } from "../../../packages/ui/dist/provider-row.js";
import { homeSnapshots, homeProviders, homeCard, pendingReading, needsClaudeHelp, REFRESH_SECONDS } from "./home-state.js";
import { claudePollRow } from "./first-run.js";

const now = "2026-09-08T06:32:00.000Z";
const snapshot = (provider, value, observedAt) => ({
  provider, value, observedAt, meter: "SEVEN_DAY", unit: "PERCENT",
  source: "internal_payload", precision: "exact", window: { kind: "rolling", durationSeconds: 604800 },
  expiresAt: new Date(Date.parse(observedAt) + 60000).toISOString(),
});
const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
const rows = (snapshots, providers) => buildProviderAccountRows(homeSnapshots(snapshots), now, [], { providers });

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}
const doc = { createElement: (tag) => new Element(tag) };
const cardOptions = (overrides = {}) => ({
  detections: null, connections: [], pollEnabled: false,
  createRow: (row) => ({ markup: providerRowMarkup(row) }), openConnection() {}, ...overrides,
});

test("four minute Codex is live beside Claude observed twenty eight hours earlier", () => {
  const input = [snapshot("CODEX", 25, "2026-09-08T06:28:00.000Z"),
    ...["FIVE_HOUR", "SEVEN_DAY", "SEVEN_DAY_SONNET"].map((meter) => ({
      ...snapshot("CLAUDE", 20, "2026-09-07T01:59:00.000Z"), meter,
    }))];
  const result = rows(input, ["CODEX", "CLAUDE"]);
  const codex = result.find((row) => row.provider === "CODEX");
  const claude = result.find((row) => row.provider === "CLAUDE");
  assert.equal(codex.windows[0].state, "fresh");
  assert.ok(claude.windows.every((window) => window.state === "stale"));
  assert.match(providerRowMarkup(codex), /data-band="green"/u);
  assert.match(providerRowMarkup(claude), /data-band="stale"/u);
  assert.equal(input[0].expiresAt, "2026-09-08T06:29:00.000Z", "cached observation is not rewritten");
});

test("each automated provider becomes hatched only beyond its own interval", () => {
  for (const [provider, seconds] of Object.entries(REFRESH_SECONDS)) {
    for (const [offset, state] of [[-1, "fresh"], [0, "fresh"], [1, "stale"]]) {
      const observed = new Date(Date.parse(now) - seconds * 1000 - offset).toISOString();
      assert.equal(rows([snapshot(provider, 25, observed)], [provider])[0].windows[0].state, state, provider);
    }
  }
  const manual = { ...snapshot("CODEX", 25, "2026-09-08T06:28:00.000Z"), source: "manual_entry" };
  assert.equal(homeSnapshots([manual])[0], manual);
});

test("live 25 and 85 percent rows use the shared green and orange token bands", () => {
  for (const [value, band] of [[0, "green"], [59, "green"], [60, "yellow"], [79, "yellow"], [80, "orange"], [89, "orange"], [90, "red"], [100, "red"]]) {
    const markup = providerRowMarkup(rows([snapshot("CODEX", value, "2026-09-08T06:28:00.000Z")], ["CODEX"])[0]);
    assert.match(markup, new RegExp(`data-state="fresh" data-band="${band}"`));
    assert.doesNotMatch(markup, /data-band="stale"/u);
    assert.ok(read("../../../packages/ui/src/provider-row.ts").includes(`var(--ol-band-${band}-fill,`));
    assert.ok(read("../../../packages/ui/src/tokens.css").includes(`--ol-band-${band}-fill:`));
  }
  assert.match(read("./index.html"), /tokens\.css/u);
  assert.match(read("../scripts/build-ui.mjs"), /"home-state\.js"/u);
});

test("Home adopts every detected provider and persisted connection with no readings or UI setup", () => {
  const detections = { providers: ["antigravity", "gemini_cli", "grok", "kimi"].map((provider_id) => ({ provider_id, state: "present" })) };
  const providers = homeProviders([], detections, [{ provider: "OPENROUTER" }], []);
  assert.deepEqual(providers, ["ANTIGRAVITY", "GEMINI_CLI", "GROK", "KIMI", "OPENROUTER"]);
  const result = rows([], providers);
  assert.equal(result.length, 5);
  for (const row of result) {
    const card = homeCard(row, cardOptions({ detections, connections: [{ provider: "OPENROUTER" }] }), doc);
    assert.equal(card.children[1].textContent, "No reading yet.");
    assert.equal(card.children[2].textContent, pendingReading(row.provider, detections, [], false));
    assert.doesNotMatch(card.children[0].markup, /role="progressbar"/u);
  }
});

test("unavailable providers always name one action and never show an empty card", () => {
  for (const [provider, state, expected] of [
    ["ANTIGRAVITY", "present", "Start Antigravity once and this bar refreshes itself."],
    ["GEMINI_CLI", "installed_logged_out", "Sign in with Gemini CLI to refresh this bar."],
    ["GROK", "installed_logged_out", "Sign in with Grok to refresh this bar."],
    ["KIMI", "installed_logged_out", "Sign in with Kimi to refresh this bar."],
  ]) {
    const detections = { antigravity_running: false, providers: [{ provider_id: provider.toLowerCase(), state }] };
    const card = homeCard(rows([], [provider])[0], cardOptions({ detections }), doc);
    assert.equal(card.children[1].textContent, "No reading yet.");
    assert.equal(card.children[2].textContent, expected);
    assert.doesNotMatch(expected, /[-\u2010-\u2015]/u);
  }
});

test("a stopped provider hatches its last reading, keeps its number and says its age", () => {
  const detections = { antigravity_running: false };
  const snapshots = [snapshot("ANTIGRAVITY", 85, "2026-09-08T06:28:00.000Z")];
  const adjusted = homeSnapshots(snapshots, { detections, now });
  const row = buildProviderAccountRows(adjusted, now, [], { providers: ["ANTIGRAVITY"] })[0];
  const card = homeCard(row, cardOptions({ detections, snapshots, now }), doc);
  assert.match(card.children[0].markup, /data-band="stale"/u);
  assert.match(card.children[0].markup, /85/u);
  assert.equal(card.children[1].textContent, "Last seen 4 minutes ago.");
  assert.equal(card.children[2].textContent, "Start Antigravity once and this bar refreshes itself.");
  const live = homeSnapshots(snapshots, { detections: { antigravity_running: true }, now });
  assert.equal(buildProviderAccountRows(live, now, [], { providers: ["ANTIGRAVITY"] })[0].windows[0].state, "fresh");
});

test("a failed native read hatches a recent cached value for every provider", () => {
  for (const provider of Object.keys(REFRESH_SECONDS)) {
    const snapshots = homeSnapshots([snapshot(provider, 60, "2026-09-08T06:28:00Z")], { now, failedProviders: [provider] });
    assert.equal(buildProviderAccountRows(snapshots, now, [], { providers: [provider] })[0].windows[0].state, "stale");
  }
});

test("a later background observation restores the live bar after a failed refresh", () => {
  const input = [snapshot("CODEX", 25, "2026-09-08T06:31:00Z")];
  const refreshed = homeSnapshots(input, { now, failedProviders: ["CODEX"], failedAt: "2026-09-08T06:30:00Z" });
  assert.equal(buildProviderAccountRows(refreshed, now, [], { providers: ["CODEX"] })[0].windows[0].state, "fresh");
});

test("the pending reading and its action live inside the provider card border", () => {
  const article = new Element("article");
  const styles = [];
  const rendered = { shadowRoot: { querySelector: () => article, append: (style) => styles.push(style) } };
  const card = homeCard(rows([], ["ANTIGRAVITY"])[0], cardOptions({ createRow: () => rendered }), doc);
  assert.deepEqual(card.children, [rendered]);
  assert.equal(article.children[0].textContent, "No reading yet.");
  assert.equal(article.children[1].textContent, "Start Antigravity once and this bar refreshes itself.");
  assert.match(styles[0].textContent, /\.column-label, \.windows \{ display: none; \}/u);
});

test("a provider with a reading keeps its bar and the Home card layout", () => {
  const row = rows([snapshot("KIMI", 25, "2026-09-08T06:28:00.000Z")], ["KIMI"])[0];
  const card = homeCard(row, cardOptions(), doc);
  assert.equal(card.className, "home-provider-card");
  assert.equal(card.children.length, 1);
  assert.match(card.children[0].markup, /role="progressbar"/u);
  assert.match(read("./surfaces.css"), /\.provider-rows > \.home-provider-card\s*\{\s*grid-column: span 6;/u);
});

test("stale Claude with polling off explains both sources and opens its connection row", () => {
  const row = rows([snapshot("CLAUDE", 20, "2026-09-07T01:59:00Z")], ["CLAUDE"])[0];
  const opened = [];
  const card = homeCard(row, cardOptions({ openConnection: (provider) => opened.push(provider) }), doc);
  assert.equal(card.children[2].textContent, "Open Claude connection to set up its status line and refresh this bar.");
  card.children[3].listeners.click();
  assert.deepEqual(opened, ["claude"]);
  assert.equal(needsClaudeHelp(row, true), false);
  assert.equal(needsClaudeHelp(row, null), false);
  assert.equal(needsClaudeHelp({ ...row, windows: [{ state: "fresh" }] }, false), false);
  assert.match(read("./index.html"), /id="claude-poll-control"/u);
  assert.match(read("./app.js"), /selectTab\(TAB_CONNECTIONS, true\);\s+openProviderConnection\(provider\)/u);
});

test("the connection poll switch persists before showing on and restores off on failure", async () => {
  globalThis.document = doc;
  try {
    for (const ok of [true, false]) {
      let finish;
      const requested = [];
      const persisted = [];
      const control = claudePollRow({ setClaudePoll(value) {
        requested.push(value);
        return new Promise((resolve) => { finish = resolve; });
      } }, false, (value) => persisted.push(value), "connection-claude-poll");
      const input = control.children[0].children[0];
      input.checked = true;
      input.listeners.change();
      assert.equal(input.checked, false);
      assert.equal(input.disabled, true);
      assert.deepEqual(requested, [true]);
      finish({ ok, value: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(input.checked, ok);
      assert.equal(input.disabled, false);
      assert.deepEqual(persisted, ok ? [true] : []);
    }
  } finally { delete globalThis.document; }
});

test("Home has exactly provider window bars with no featured meter", () => {
  assert.doesNotMatch(read("./index.html"), /Closest to its limit|hero-meter|class="hero"/u);
  assert.doesNotMatch(read("./app.js"), /heroWindow|paintHero|heroObserved|resetInstants|live-meter/u);
  assert.doesNotMatch(read("./surfaces.css"), /\.hero[ {.-]/u);
  const row = rows([snapshot("CODEX", 25, "2026-09-08T06:28:00Z")], ["CODEX"])[0];
  assert.equal((homeCard(row, cardOptions(), doc).children[0].markup.match(/role="progressbar"/gu) ?? []).length, 1);
});
