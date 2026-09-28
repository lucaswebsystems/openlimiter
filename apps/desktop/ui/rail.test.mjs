import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { mountAgents } from "./agents.js";
import { accountView, ageLabel, dragOffset, renderAccounts, renderSessions, startRail, startRailTheme, RAIL_COPY } from "./rail.js";
import { wireRailVisibility, renderSettings, RAIL_SETTINGS_COPY } from "./settings.js";

const read = file => readFileSync(new URL(file, import.meta.url), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const now = Date.parse("2026-09-28T12:00:00Z");
const row = patch => ({ provider: "claude", account: null, headlineMeterId: "quota", kind: "quota_percent",
  value: 41, meaning: "used", windowLabel: "5 hours", resetAt: "2026-09-28T14:00:00Z",
  freshness: "fresh", availability: "available", band: "green", precision: "exact", fidelityMarker: null,
  sessions: { busy: 0, waiting: 0, done: 0, idle: 0, unknown: 0 }, ...patch });
const record = patch => ({ sessionId: "synthetic-session", agent: "claude_code", state: "busy", confidence: "explicit",
  firstObservedAt: "2026-09-28T10:00:00Z", observedAt: "2026-09-28T11:57:00Z",
  elapsedSeconds: 7200, computer: "local", ...patch });
const snapshot = patch => ({ accounts: [row()], sessions: [], window: { available: true, visible: true, unfolded: true,
  keepOpen: false, offset: 120, cardOpen: false, cardAnchor: null }, ...patch });

class Element {
  dataset = {};
  children = [];
  handlers = {};
  attributes = {};
  styles = {};
  classes = new Set();
  ownText = "";
  className = "";
  disabled = false;
  checked = false;
  classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
  style = { setProperty: (name, value) => { this.styles[name] = value; } };
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  setPointerCapture() {}
  getBoundingClientRect() { return { top: this.top ?? 123 }; }
}

function documentFixture() {
  const nodes = Object.fromEntries(["accounts", "sessions", "keep", "close", "grip", "status"].map(id => [id, new Element()]));
  const doc = new Element();
  doc.body = new Element();
  doc.querySelector = selector => nodes[selector.slice(1)];
  doc.createElement = tag => Object.assign(new Element(), { tag });
  return { doc, nodes };
}

for (const [name, fixture, reading, band] of [
  ["green", row(), "41%", "green"],
  ["watch", row({ value: 60, band: "yellow" }), "60%", "yellow"],
  ["high", row({ value: 80, band: "orange" }), "80%", "orange"],
  ["critical remaining", row({ value: 8, meaning: "remaining", band: "red" }), "8%", "red"],
  ["stale", row({ freshness: "stale", band: "stale" }), "41%", "stale"],
  ["signed out", row({ value: null, availability: "missing_credentials", freshness: "unknown", band: "stale" }), "Signed out", "none"],
  ["expired", row({ value: null, availability: "expired_credentials", band: "stale" }), "Signed out", "none"],
  ["unknown", row({ value: null, availability: "quota_unavailable", freshness: "unknown", band: "stale" }), "Unknown", "stale"],
  ["balance", row({ provider: "openrouter", kind: "balance", value: 6.2, meaning: "remaining", band: "stale" }), "6.2", "none"],
  ["unlimited", row({ value: null, availability: "unlimited", band: "stale" }), "Unlimited", "none"],
  ["manual", row({ precision: "manual", fidelityMarker: "manual" }), "41%", "green"],
]) {
  test(`snapshot renders ${name} in tabs and card`, () => {
    for (const isCard of [false, true]) {
      const { doc, nodes } = documentFixture();
      renderAccounts(doc, nodes.accounts, snapshot({ accounts: [fixture] }).accounts, isCard, () => {}, now);
      const tab = nodes.accounts.children[0];
      assert.equal(tab.tag, isCard ? "section" : "button");
      assert.equal(tab.attributes["data-band"], band);
      assert.ok(tab.textContent.includes(reading));
      assert.ok(tab.attributes["aria-label"].includes(fixture.windowLabel));
      if (name === "critical remaining") assert.equal(tab.children[1].styles["--meter"], "92%");
      if (name === "stale") assert.ok(tab.textContent.includes("Age unavailable"));
      if (name === "balance") { assert.equal(tab.children[1].styles["--meter"], "0%"); assert.ok(!tab.textContent.includes("$")); }
      if (name === "manual") assert.ok(tab.textContent.includes("manual"));
    }
  });
}

test("unknown values cannot become a numeric meter and elapsed resets never claim a reset", () => {
  for (const value of [null, NaN, Infinity, -1, 101]) assert.equal(accountView(row({ value })).reading, "Unknown");
  const { doc, nodes } = documentFixture();
  renderAccounts(doc, nodes.accounts, [row({ resetAt: "2026-09-28T10:00:00Z" })], true, () => {}, now);
  assert.ok(nodes.accounts.textContent.includes("Awaiting updated reading"));
});

for (const [state, text, glyph] of [["busy", "Working", ""], ["waiting", "Needs you", "?"], ["done", "Done", "✓"], ["idle", "Idle", ""], ["unknown", "Unknown", "?"]]) {
  test(`sanitized ${state} session renders words, glyph and observed age`, () => {
    const { doc, nodes } = documentFixture();
    for (const isCard of [false, true]) {
      renderSessions(doc, nodes.sessions, [record({ state, userProjectLabel: "Fixture project" })], isCard, () => {}, now);
      const tab = nodes.sessions.children[0];
      assert.equal(tab.attributes["data-agent"], state);
      assert.ok(tab.textContent.includes(text));
      assert.ok(tab.textContent.includes("3 min ago"));
      assert.ok(!tab.textContent.includes("Fixture project"));
      assert.ok(tab.textContent.includes("This computer"));
      assert.ok(tab.textContent.includes("120:00 elapsed"));
      assert.equal(tab.children[0].children[0].textContent, glyph);
      if (state === "busy") assert.equal(tab.children[0].children[0].children.length, 3);
      if (state === "waiting") assert.ok(tab.textContent.includes("Waiting for your input"));
    }
  });
}

test("cancelled and failed sessions never receive a success tick", () => {
  const { doc, nodes } = documentFixture();
  for (const outcome of ["cancelled", "failed"]) {
    renderSessions(doc, nodes.sessions, [record({ state: "unknown", outcome })], true, () => {}, now);
    assert.ok(nodes.sessions.textContent.includes(RAIL_COPY[outcome]));
    assert.ok(!nodes.sessions.textContent.includes("✓"));
  }
});

test("age uses observation time and handles malformed or future observations honestly", () => {
  assert.equal(ageLabel("2026-09-28T11:59:45Z", now), "15 sec ago");
  assert.equal(ageLabel("2026-09-28T09:00:00Z", now), "3 h ago");
  assert.equal(ageLabel("2026-09-26T09:00:00Z", now), "2 d ago");
  assert.equal(ageLabel("invalid", now), "Age unavailable");
  assert.equal(ageLabel("2026-09-29T09:00:00Z", now), "Age unavailable");
});

test("stale quota ages come from observedAt, including absent timestamps", () => {
  const { doc, nodes } = documentFixture();
  for (const [observedAt, expected] of [["2026-09-28T11:57:00Z", "3 min ago"],
    [null, "Age unavailable"], ["invalid", "Age unavailable"], ["2026-09-29T00:00:00Z", "Age unavailable"]]) {
    for (const isCard of [false, true]) {
      renderAccounts(doc, nodes.accounts, [row({ freshness: "stale", observedAt })], isCard, () => {}, now);
      assert.ok(nodes.accounts.textContent.includes(expected));
    }
  }
});

test("Rail renders snapshot sessions without a direct activity read and only cards locate", async () => {
  for (const search of ["", "?card"]) {
    const { doc, nodes } = documentFixture();
    const calls = [];
    const stop = startRail(doc, async (command, args) => {
      calls.push([command, args]);
      if (command === "plugin:rail|rail_snapshot") return snapshot({ sessions: [
        record({ state: "busy" }), record({ sessionId: "waiting", state: "waiting" }), record({ sessionId: "done", state: "done" }),
      ] });
      if (command === "plugin:activity|activity_locate") return "flashed";
      throw new Error("denied");
    }, search);
    try {
      await tick();
      assert.match(nodes.sessions.textContent, /Working/);
      assert.match(nodes.sessions.textContent, /Needs you/);
      assert.match(nodes.sessions.textContent, /Done/);
      assert.deepEqual(calls.map(([command]) => command), ["plugin:rail|rail_snapshot"]);
      const buttons = nodes.sessions.children.flatMap(row => row.children.filter(child => child.className === "session-locate"));
      assert.equal(buttons.length, search ? 3 : 0);
      if (search) {
        await buttons[1].handlers.click();
        assert.deepEqual(calls.at(-1), ["plugin:activity|activity_locate", { sessionId: "waiting" }]);
        assert.equal(nodes.status.textContent, "App highlighted in the taskbar");
      }
    } finally { stop(); }
  }
});

test("session age updates preserve the card locate button", () => {
  const { doc, nodes } = documentFixture();
  renderSessions(doc, nodes.sessions, [record()], true, () => {}, now, () => {});
  const tab = nodes.sessions.children[0];
  const button = tab.children[2];
  renderSessions(doc, nodes.sessions, [record({ elapsedSeconds: 7201 })], true, () => {}, now + 1000, () => {});
  assert.equal(nodes.sessions.children[0], tab);
  assert.equal(tab.children[2], button);
  assert.match(tab.textContent, /120:01 elapsed/);
});

test("stale age updates preserve the quota tab for keyboard activation", () => {
  const { doc, nodes } = documentFixture();
  const reading = row({ freshness: "stale", observedAt: "2026-09-28T11:59:45Z" });
  renderAccounts(doc, nodes.accounts, [reading], false, () => {}, now);
  const tab = nodes.accounts.children[0];
  assert.match(tab.textContent, /15 sec ago/);
  renderAccounts(doc, nodes.accounts, [reading], false, () => {}, now + 1000);
  assert.equal(nodes.accounts.children[0], tab);
  assert.match(tab.textContent, /16 sec ago/);
});

test("desktop shell mounts the Agents component inside Home and disposes on unload", async () => {
  const html = read("./index.html");
  assert.match(html, /href="\.\/agents.css"/);
  const homeStart = html.indexOf('<section id="panel-meters"');
  const hostStart = html.indexOf('<div id="agents-mount">');
  assert.ok(homeStart < hostStart && hostStart < html.indexOf("</section>", homeStart));
  const app = read("./app.js");
  assert.match(app, /import \{ mountAgents \} from "\.\/agents.js"/);
  const wiring = app.match(/const disposeAgents = mountAgents\(elements.agentsMount\);\s*window.addEventListener\("beforeunload", disposeAgents, \{ once: true \}\);/);
  assert.ok(wiring);
  const { doc } = documentFixture();
  const host = new Element(); host.ownerDocument = doc;
  let dispose;
  runInNewContext(wiring[0], {
    elements: { agentsMount: host },
    mountAgents: target => mountAgents(target, { now: () => now, client: {
      sessions: async () => [record({ state: "waiting" })],
      preferences: async () => { throw new Error("unavailable"); },
    } }),
    window: { addEventListener: (event, callback) => { assert.equal(event, "beforeunload"); dispose = callback; } },
  });
  try {
    await tick();
    assert.match(host.textContent, /Agents/);
    assert.match(host.textContent, /Needs you/);
    assert.match(host.textContent, /This computer/);
  } finally { dispose(); }
  assert.equal(host.children.length, 0);
});

test("built Home and Rail include the Agents component and its local dependencies", () => {
  for (const file of ["agents.js", "agents.css", "agents.en.js", "agents.en.json"]) {
    assert.equal(read(`./dist/${file}`), read(`./${file}`), `${file} must be packaged by build-ui`);
  }
});

test("loading, empty and unavailable states are distinct and activity failure cannot hide accounts", async () => {
  const { doc, nodes } = documentFixture();
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const stop = startRail(doc, command => command.endsWith("rail_snapshot") ? promise : Promise.reject(new Error("denied")));
  try {
    assert.ok(nodes.accounts.textContent.includes("Loading"));
    release(snapshot({ accounts: [], sessions: null }));
    await tick();
    assert.ok(nodes.accounts.textContent.includes("No accounts"));
    assert.ok(nodes.sessions.textContent.includes("Agent activity unavailable"));
  } finally { stop(); }
  const failed = documentFixture();
  const stopFailed = startRail(failed.doc, async () => { throw new Error("private native detail"); });
  try {
    await tick();
    assert.ok(failed.nodes.accounts.textContent.includes("Rail unavailable"));
    assert.ok(!failed.nodes.status.textContent.includes("private"));
  } finally { stopFailed(); }
});

test("Rail commands, bounded anchors, drag, keyboard and literal text preserve L3a behavior", async () => {
  const { doc, nodes } = documentFixture();
  const calls = [];
  const fixture = snapshot({ accounts: [row({ provider: "<b>untrusted</b>" })] });
  const stop = startRail(doc, async (command, args) => {
    calls.push([command, args]);
    return command.endsWith("rail_snapshot") ? fixture : [];
  });
  try {
    await tick();
    assert.ok(nodes.accounts.children[0].attributes["aria-label"].includes("<b>untrusted</b>"));
    assert.equal(doc.body.classes.has("folded"), false);
    nodes.accounts.children[0].top = 500;
    nodes.accounts.children[0].handlers.pointerenter();
    nodes.accounts.children[0].top = -20;
    nodes.accounts.children[0].handlers.focus();
    nodes.keep.handlers.click();
    nodes.grip.handlers.pointerdown({ button: 0, screenY: -500, pointerId: 1 });
    nodes.grip.handlers.pointermove({ screenY: -450 });
    nodes.grip.handlers.pointerup();
    await tick();
    nodes.grip.handlers.keydown({ key: "ArrowDown", preventDefault() {} });
    nodes.close.handlers.click();
    doc.handlers.keydown({ key: "Escape", preventDefault() {} });
    await tick();
    assert.deepEqual(calls.slice(1), [
      ["plugin:rail|rail_card_open", { anchor: 320 }], ["plugin:rail|rail_card_open", { anchor: 0 }],
      ["plugin:rail|rail_set_keep_open", { keepOpen: true }], ["plugin:rail|rail_move_offset", { offset: 170 }],
      ["plugin:rail|rail_move_offset", { offset: 130 }], ["plugin:rail|rail_set_visible", { visible: false }],
      ["plugin:rail|rail_card_close", {}],
    ]);
  } finally { stop(); }
  assert.equal(dragOffset(120, 200, -100), 0);
  assert.equal(dragOffset(99990, 0, 100), 100000);
});

test("folded and card window fixtures use native state, and card close never hides the Rail", async () => {
  for (const search of ["", "?card"]) {
    const { doc, nodes } = documentFixture();
    const calls = [];
    const stop = startRail(doc, async (command, args) => {
      calls.push([command, args]);
      return command.endsWith("rail_snapshot") ? snapshot({ window: { unfolded: false, keepOpen: true, cardOpen: true } }) : [];
    }, search);
    try {
      await tick();
      assert.equal(doc.body.classes.has("card"), Boolean(search));
      assert.equal(doc.body.classes.has("folded"), !search);
      assert.equal(nodes.keep.attributes["aria-pressed"], "true");
      if (search) {
        assert.ok(doc.body.classes.has("morphing"));
        nodes.close.handlers.click();
        await tick();
        assert.deepEqual(calls.at(-1), ["plugin:rail|rail_card_close", {}]);
      }
    } finally { stop(); }
  }
});

test("Settings reads persisted visibility and invokes rail_set_visible in both directions", async () => {
  const control = new Element();
  const status = new Element();
  const calls = [];
  let visible = false;
  await wireRailVisibility(control, status, async (command, args) => {
    calls.push([command, args]);
    if (command.endsWith("rail_set_visible")) visible = args.visible;
    else return snapshot({ window: { visible, suppressed: true } });
  });
  assert.equal(control.checked, false);
  assert.equal(control.disabled, false);
  for (const next of [true, false]) {
    control.checked = next;
    await control.handlers.change();
    assert.equal(control.checked, next);
    assert.equal(visible, next);
  }
  assert.deepEqual(calls.filter(([command]) => command.endsWith("rail_set_visible")), [
    ["plugin:rail|rail_set_visible", { visible: true }], ["plugin:rail|rail_set_visible", { visible: false }],
  ]);
});

test("Settings restores persisted state on failure and disables a missing backend", async () => {
  const control = new Element();
  const status = new Element();
  await wireRailVisibility(control, status, async command => {
    if (command.endsWith("rail_set_visible")) throw new Error("write failed");
    return snapshot({ window: { visible: true } });
  });
  control.checked = false;
  await control.handlers.change();
  assert.equal(control.checked, true);
  assert.equal(status.textContent, RAIL_SETTINGS_COPY.saveFailed);
  const absent = new Element();
  await wireRailVisibility(absent, status, async () => { throw new Error("absent"); });
  assert.equal(absent.disabled, true);
  assert.equal(status.textContent, RAIL_SETTINGS_COPY.unavailable);
});

test("Settings retains the successful write if the following snapshot read fails", async () => {
  const control = new Element();
  const status = new Element();
  let saved = false;
  await wireRailVisibility(control, status, async command => {
    if (command.endsWith("rail_set_visible")) { saved = true; return; }
    if (saved) throw new Error("snapshot unavailable");
    return snapshot({ window: { visible: false } });
  });
  control.checked = true;
  await control.handlers.change();
  assert.equal(control.checked, true);
  assert.equal(control.disabled, false);
});

test("Rail follows the desktop theme, then system light and dark, including storage denial", () => {
  const doc = { documentElement: { dataset: {} } };
  let saved = "light";
  const handlers = {};
  const media = { matches: false, addEventListener: (_, fn) => { handlers.media = fn; }, removeEventListener() {} };
  const win = { matchMedia: () => media, localStorage: { getItem: () => saved },
    addEventListener: (_, fn) => { handlers.storage = fn; }, removeEventListener() {} };
  const stop = startRailTheme(doc, win);
  assert.equal(doc.documentElement.dataset.theme, "light");
  saved = "dark";
  handlers.storage();
  assert.equal(doc.documentElement.dataset.theme, "dark");
  saved = null;
  media.matches = true;
  handlers.media();
  assert.equal(doc.documentElement.dataset.theme, "light");
  win.localStorage.getItem = () => { throw new Error("denied"); };
  media.matches = false;
  handlers.media();
  assert.equal(doc.documentElement.dataset.theme, "dark");
  stop();
});

test("Settings Rail switch still mounts when the notification backend is absent", async () => {
  const control = new Element();
  const status = new Element();
  const mount = { innerHTML: "", querySelector: selector => selector === "#rail-visible" ? control : status };
  await renderSettings(mount);
  assert.match(mount.innerHTML, /for="rail-visible"/);
  assert.match(mount.innerHTML, /Show the Rail/);
  assert.equal(control.disabled, true);
});

test("Rail styles use existing tokens, local unchanged marks and reduced motion", () => {
  const html = read("./rail.html");
  const css = read("./rail.css");
  const js = read("./rail.js");
  const tokens = read("../../../packages/ui/src/tokens.css");
  assert.match(html, /engine\/ui\/tokens.css/);
  assert.doesNotMatch(html, /https?:|<script[^>]*>[^<]+<\/script>/);
  assert.doesNotMatch(js, /innerHTML|set_focus|startDragging|fetch\(/);
  for (const source of [html, css, js, read("./settings.js")]) assert.doesNotMatch(source, /#[\da-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(/iu);
  for (const [, name] of css.matchAll(/var\((--ol-[\w-]+)/g)) assert.ok(tokens.includes(`${name}:`), name);
  assert.match(css, /font-family: var\(--ol-font-sans\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /animation: none !important; transition: none !important/);
  assert.match(css, /var\(--ol-band-hatched-pattern\)/);
  assert.match(js, /prefers-color-scheme: light/);
  for (const name of ["claude", "codex", "antigravity", "openrouter", "gemini", "opencode", "grok", "kimi", "manual"]) {
    assert.equal(read(`./dist/marks/${name}.svg`), read(`../../../packages/ui/src/marks/${name}.svg`));
  }
});

test("new English strings have catalog keys and no prose dashes", () => {
  const catalog = JSON.parse(read("../../web/messages/en.json"));
  assert.deepEqual(catalog.desktopRail, RAIL_COPY);
  assert.deepEqual(catalog.desktopRailSettings, RAIL_SETTINGS_COPY);
  for (const text of [...Object.values(RAIL_COPY), ...Object.values(RAIL_SETTINGS_COPY)]) assert.doesNotMatch(text, /[\u2013\u2014-]/u);
});
