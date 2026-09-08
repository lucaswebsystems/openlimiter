import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const values = new Map();
globalThis.window = {
  localStorage: {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  },
  dispatchEvent() {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type) {
    this.type = type;
  }
};

const {
  CONFIGURED_PROVIDERS_STORAGE_KEY,
  configureProvider,
  isProviderConfigured,
  readConfiguredProviders,
  unconfigureProvider,
  adoptDetectedProviders,
  readRemovedProviders,
  homeSelectionControl,
} = await import("./configured-providers.js");
const { homeProviders } = await import("./home-state.js");

test("stores only explicitly supported providers", () => {
  values.clear();
  configureProvider("codex");
  configureProvider("gemini-cli");
  configureProvider("manual");
  assert.deepEqual(readConfiguredProviders(), ["CODEX", "GEMINI_CLI"]);
  assert.equal(isProviderConfigured("CODEX"), true);
  assert.equal(isProviderConfigured("MANUAL"), false);
  assert.equal(values.has(CONFIGURED_PROVIDERS_STORAGE_KEY), true);
});

test("removes a configured provider without affecting the others", () => {
  values.clear();
  configureProvider("CLAUDE");
  configureProvider("CODEX");
  unconfigureProvider("claude");
  assert.deepEqual(readConfiguredProviders(), ["CODEX"]);
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  async click() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    this.listeners.click?.(event);
    if (event.prevented) return;
    this.checked = !this.checked;
    await this.listeners.change?.();
  }
  async key(key, repeat = false) {
    let prevented = false;
    this.listeners.keydown({ key, repeat, preventDefault() { prevented = true; } });
    await new Promise(setImmediate);
    return prevented;
  }
}
const doc = { createElement: (tag) => new Element(tag) };

test("provider switch supports both keyboard keys, persists removal and excludes it from Home after repeated scans", async () => {
  values.clear();
  const detection = { providers: [{ provider_id: "codex", state: "present" }] };
  adoptDetectedProviders(detection);
  const writes = [];
  let changed = 0;
  const control = homeSelectionControl("CODEX", () => changed++, doc, async (...args) => { writes.push(args); return { ok: true }; }, "Codex");
  const [input, track] = control.children;
  assert.equal(input.tagName, "input");
  assert.equal(input.type, "checkbox");
  assert.equal(input.attributes.role, "switch");
  assert.equal(input.attributes["aria-label"], "Codex");
  assert.equal(input.attributes["aria-checked"], "true");
  assert.equal(track.attributes["aria-hidden"], "true");
  assert.equal(await input.key(" "), true);
  assert.equal(input.checked, false);
  assert.equal(input.attributes["aria-checked"], "false");
  for (let scan = 0; scan < 3; scan++) {
    adoptDetectedProviders(JSON.parse(JSON.stringify(detection)));
    assert.deepEqual(readConfiguredProviders(), []);
    assert.deepEqual(homeProviders([], detection, [{ provider: "CODEX" }], [{ provider: "CODEX" }], readRemovedProviders()), []);
  }
  const reopened = homeSelectionControl("CODEX", () => {}, doc).children[0];
  assert.equal(reopened.checked, false);
  assert.equal(await input.key("Enter"), true);
  assert.equal(input.attributes["aria-checked"], "true");
  await input.key("Enter", true);
  assert.equal(await input.key("Tab"), false);
  assert.deepEqual(writes, [["CODEX", false], ["CODEX", true]]);
  assert.equal(changed, 2);
  assert.deepEqual(readRemovedProviders(), []);
  assert.deepEqual(homeProviders(readConfiguredProviders(), detection, [], [], []), ["CODEX"]);
  const catalogue = readFileSync(new URL("./connections.js", import.meta.url), "utf8");
  assert.match(catalogue, /if \(rowData.connectorId\) \{\s*rowEl.append\(homeSelectionControl/u);
  assert.match(catalogue, /backend.setProviderEnabled, rowData.displayName/u);
});

test("saving a switch is serialized and a refused native write restores its state with feedback", async () => {
  values.clear();
  configureProvider("CODEX");
  let finish, saves = 0;
  const [input, , note] = homeSelectionControl("CODEX", () => assert.fail("a failed save changed Home"), doc,
    () => { saves++; return new Promise((resolve) => { finish = resolve; }); }).children;
  const running = input.click();
  await input.key("Enter");
  await input.click();
  assert.equal(saves, 1);
  assert.equal(input.attributes["aria-disabled"], "true");
  finish({ ok: false });
  await running;
  assert.equal(input.checked, true);
  assert.equal(input.attributes["aria-checked"], "true");
  assert.match(note.textContent, /could not be saved/u);
  assert.doesNotMatch(note.textContent, /[-\u2010-\u2015]/u);
  assert.equal(isProviderConfigured("CODEX"), true);
});
