import assert from "node:assert/strict";
import test from "node:test";
import { tabSwitcher } from "./tabs.js";

function surface() {
  const listeners = new Map();
  const tabs = ["usage", "tools", "settings"].map((id) => ({
    id: `tab-${id}`, tabIndex: 0, attributes: {}, focus() { this.focused = true; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(name, listener) { listeners.set(`${this.id}:${name}`, listener); },
  }));
  const panels = tabs.map((tab) => ({ id: `tab-panel-${tab.id.slice(4)}`, hidden: false,
    attributes: { "aria-labelledby": tab.id }, getAttribute(name) { return this.attributes[name] ?? null; } }));
  return { tabs, panels, listeners, fire: (tab, key) => listeners.get(`${tab.id}:keydown`)({ key, preventDefault() {} }) };
}

test("tabSwitcher selects Usage by default and persists the selected tab", () => {
  const view = surface();
  const values = new Map();
  const storage = { getItem: () => null, setItem: (key, value) => values.set(key, value) };
  const state = tabSwitcher({ tabs: view.tabs, panels: view.panels, storage });
  assert.equal(state.current(), view.tabs[0]);
  state.select(view.tabs[1]);
  assert.equal(view.tabs[1].attributes["aria-selected"], "true");
  assert.equal(view.panels[1].hidden, false);
  assert.equal(view.panels[0].hidden, true);
  assert.equal(values.get("openlimiter-tab"), "tools");
});

test("tabSwitcher wraps arrows, Home and End, including a throwing store", () => {
  const view = surface();
  tabSwitcher({ tabs: view.tabs, panels: view.panels, storage: { getItem: () => { throw new Error("no storage"); }, setItem: () => { throw new Error("no storage"); } } });
  view.fire(view.tabs[0], "ArrowLeft");
  assert.equal(view.tabs[2].attributes["aria-selected"], "true");
  view.fire(view.tabs[2], "Home");
  assert.equal(view.tabs[0].attributes["aria-selected"], "true");
  view.fire(view.tabs[0], "End");
  assert.equal(view.tabs[2].attributes["aria-selected"], "true");
});

test("tabSwitcher treats a throwing localStorage getter like unavailable storage", () => {
  const view = surface();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("storage getter refused"); },
  });
  try {
    const state = tabSwitcher({ tabs: view.tabs, panels: view.panels });
    assert.equal(state.current(), view.tabs[0]);
    assert.equal(view.panels[0].hidden, false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});
