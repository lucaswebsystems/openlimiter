import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * A recording document.
 *
 * It is deliberately not a DOM. What matters about this code is which sink a
 * value off disk arrives at: text, or markup. So the stub records every
 * textContent and every innerHTML assignment and the tests read those two
 * lists, which is exactly the distinction a real browser would act on.
 */
function recordingDocument() {
  const text = [];
  const markup = [];
  const created = [];
  const element = (tag) => {
    const node = {
      tag,
      className: "",
      children: [],
      attributes: {},
      set textContent(value) {
        text.push(value);
        node.text = value;
      },
      get textContent() {
        return node.text ?? "";
      },
      set innerHTML(value) {
        markup.push(value);
      },
      get innerHTML() {
        return "";
      },
      setAttribute(name, value) {
        node.attributes[name] = value;
      },
      append(...nodes) {
        node.children.push(...nodes);
      },
    };
    created.push(node);
    return node;
  };
  return {
    text,
    markup,
    created,
    document: { createElement: element },
  };
}

const APP = () => readFileSync(new URL("./app.js", import.meta.url), "utf8");

const HOSTILE = '<img src=x onerror="alert(1)">';

async function load() {
  const recorder = recordingDocument();
  globalThis.document = recorder.document;
  const module = await import("./failure-rows.js");
  return { ...recorder, buildFailureRow: module.buildFailureRow };
}

test("a provider name carrying markup arrives as text, never as markup", async () => {
  const { buildFailureRow, text, markup } = await load();
  const row = buildFailureRow(HOSTILE, "The provider did not answer in time.");

  assert.deepEqual(markup, [], "a value off disk reached innerHTML");
  assert.ok(text.includes(HOSTILE), "the provider name never reached a text sink");
  assert.equal(row.children[0].textContent, HOSTILE);
  assert.equal(row.children[0].tag, "strong");
});

test("an unknown category shows its own code as text as well", async () => {
  const { buildFailureRow, text, markup } = await load();
  /* The window falls back to the raw category when the sentence table has no
     entry, and a raw category is another value that came off disk. */
  buildFailureRow("Codex", HOSTILE);
  assert.deepEqual(markup, []);
  assert.ok(text.includes(HOSTILE));
});

test("the failures list builds nodes rather than a markup string", () => {
  const app = APP();
  const start = app.indexOf("function paintFailures(");
  const end = app.indexOf("\nasync function refresh()", start);
  const body = app.slice(start, end);

  assert.notEqual(start, -1, "paintFailures went missing");
  assert.equal(
    /\.innerHTML\s*=/u.test(body),
    false,
    "paintFailures assigns innerHTML from values read off disk",
  );
  assert.match(body, /buildFailureRow\(/u);
});

test("the window keeps its promise that nothing off disk reaches innerHTML", () => {
  const app = APP();
  /* The only innerHTML assignments left in the window are the frozen provider
     mark constants, which are string literals in this file and nothing else. */
  for (const assignment of app.matchAll(/(\w+)\.innerHTML\s*=\s*([^;\n]+)/gu)) {
    assert.match(
      assignment[2],
      /^(MARKS\[|options\.markFor\(|"")/u,
      "an innerHTML assignment carries something other than a frozen mark: " +
        assignment[0],
    );
  }
});
