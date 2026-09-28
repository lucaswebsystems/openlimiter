import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { accountLabel, dragOffset, startRail } from "./rail.js";

test("Rail placeholder preserves unknown and meter meaning", () => {
  assert.equal(accountLabel({ provider: "Codex", value: null, kind: "quota_percent", meaning: "used", windowLabel: "5 hours" }), "Codex: Unknown (5 hours)");
  assert.equal(accountLabel({ provider: "Claude", value: 42, kind: "quota_percent", meaning: "remaining", windowLabel: "week" }), "Claude: 42% remaining (week)");
  assert.equal(accountLabel({ provider: "OpenRouter", value: 6.2, kind: "balance", meaning: "remaining", windowLabel: "credits" }), "OpenRouter: 6.2 remaining (credits)");
});

test("drag uses screen coordinates so moving the window does not compound the offset", () => {
  assert.equal(dragOffset(120, -500, -450), 170);
  assert.equal(dragOffset(120, 200, -100), 0);
  assert.equal(dragOffset(99990, 0, 100), 100000);
});

test("Rail assets stay local under the existing CSP", () => {
  const html = readFileSync(new URL("./rail.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("./rail.js", import.meta.url), "utf8");
  assert.match(html, /engine\/ui\/tokens.css/);
  assert.doesNotMatch(html, /https?:|<script[^>]*>[^<]+<\/script>/);
  assert.doesNotMatch(js, /innerHTML|set_focus|startDragging/);
});

class Element {
  children = [];
  handlers = {};
  attributes = {};
  classList = { toggle() {} };
  addEventListener(name, handler) { this.handlers[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = value; }
  replaceChildren() { this.children = []; }
  append(child) { this.children.push(child); }
  setPointerCapture() {}
}

test("placeholder controls send bounded Rail commands and preserve account text", async () => {
  const nodes = Object.fromEntries(["accounts", "keep", "close", "grip", "status"].map(id => [id, new Element()]));
  const doc = new Element();
  doc.body = new Element();
  doc.querySelector = selector => nodes[selector.slice(1)];
  doc.createElement = () => new Element();
  const calls = [];
  const snapshot = { accounts: [{ provider: "<b>untrusted</b>", value: null, windowLabel: "unknown" }],
    window: { unfolded: true, keepOpen: false, offset: 120 } };
  const stop = startRail(doc, async (command, args) => {
    calls.push([command, args]);
    return command.endsWith("rail_snapshot") ? snapshot : null;
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.accounts.children[0].textContent, "<b>untrusted</b>: Unknown (unknown)");
    nodes.keep.handlers.click();
    nodes.grip.handlers.pointerdown({ button: 0, screenY: -500, pointerId: 1 });
    nodes.grip.handlers.pointermove({ screenY: -450 });
    nodes.grip.handlers.pointerup();
    nodes.close.handlers.click();
    doc.handlers.keydown({ key: "Escape", preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls.slice(1), [
      ["plugin:rail|rail_set_keep_open", { keepOpen: true }],
      ["plugin:rail|rail_move_offset", { offset: 170 }],
      ["plugin:rail|rail_set_visible", { visible: false }],
      ["plugin:rail|rail_card_close", {}],
    ]);
  } finally { stop(); }
});

test("all placeholder colour tokens exist in the bundled token sheet", () => {
  const css = readFileSync(new URL("./rail.css", import.meta.url), "utf8");
  const tokens = readFileSync(new URL("./dist/engine/ui/tokens.css", import.meta.url), "utf8");
  for (const [, name] of css.matchAll(/var\((--[\w-]+)/g)) {
    assert.ok(tokens.includes(`${name}:`), name);
  }
});
