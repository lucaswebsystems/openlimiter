import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { headerPopovers } from "./header-popovers.js";

class Element {
  constructor() { this.hidden = true; this.listeners = {}; this.attrs = {}; this.style = { setProperty: (key, value) => { this.attrs[key] = value; } }; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attrs[name] = value; }
  contains(target) { return target === this || target === this.child; }
  getBoundingClientRect() { return { bottom: 60 }; }
  querySelector() { return this.child; }
  focus() { this.focused = true; }
}

test("every header popover is a fixed body portal on the same layer above the cards", () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  for (const id of ["notification-popover", "app-menu", "phone-popover"]) {
    assert.ok(html.indexOf(`id="${id}"`) > html.indexOf("</main>"));
  }
  const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
  assert.match(css, /\.header-popover\s*\{[^}]*position: fixed;[^}]*z-index: 100;[^}]*max-height:[^}]*overflow-y: auto;/u);
});

test("all popovers keep inside clicks open, close outside and on Escape, and return focus", () => {
  const entries = [0, 1, 2].map(() => ({ panel: new Element(), button: new Element(), opened: 0, closed: 0 }));
  for (const entry of entries) {
    entry.panel.child = new Element();
    entry.onOpen = () => { entry.opened++; };
    entry.onClose = () => { entry.closed++; };
  }
  const portals = [];
  const doc = new Element(); doc.body = { append: (panel) => portals.push(panel) };
  const viewport = new Element(); viewport.innerHeight = 800;
  headerPopovers(entries, doc, viewport);
  assert.deepEqual(portals, entries.map(({ panel }) => panel));
  for (const entry of entries) {
    entry.button.listeners.click();
    assert.equal(entry.panel.hidden, false);
    assert.equal(entry.panel.child.focused, true);
    assert.equal(entry.panel.attrs["--header-popover-top"], "68px");
    doc.listeners.click({ target: entry.panel.child });
    assert.equal(entry.panel.hidden, false);
    doc.listeners.click({ target: new Element() });
    assert.equal(entry.panel.hidden, true);
    assert.equal(entry.button.focused, true);
    assert.equal(entry.button.attrs["aria-expanded"], "false");
    entry.button.focused = false;
    entry.button.listeners.click();
    doc.listeners.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(entry.panel.hidden, true);
    assert.equal(entry.button.focused, true);
    assert.equal(entry.opened, 2);
    assert.equal(entry.closed, 2);
  }
  entries[0].button.listeners.click();
  entries[1].button.listeners.click();
  assert.equal(entries[0].panel.hidden, true);
  assert.equal(entries[1].panel.hidden, false);
});
