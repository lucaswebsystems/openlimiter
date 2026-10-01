import assert from "node:assert/strict";
import test from "node:test";
import { keyRows, renderKeys } from "./pro.js";
import { fakeDocument } from "./test-dom.mjs";

/**
 * Founder decision 16, 2026-09-04. Rust decides the displayState; the key row
 * only proves it honours it, never recomputes an amount on its own, and
 * reaches for nothing else when a state carries no amount (a capped reading
 * from an older build, or any kind this build does not know).
 */
const source = (overrides = {}) => ({
  id: "b28c9d51-7f0a-4c3e-9d64-5a1b8e2f7c03",
  provider: "openai",
  keyLabel: "Org admin",
  lastFour: "ab12",
  metricKind: "spend",
  status: "eligible",
  budgetUsd: null,
  lastObservedAt: "2026-09-04T12:00:00Z",
  ...overrides,
});

const sample = (displayState) => ({
  sourceId: "b28c9d51-7f0a-4c3e-9d64-5a1b8e2f7c03",
  provider: "openai",
  metricKind: "spend",
  month: "2026-09-01",
  completeness: "complete",
  forecastDate: null,
  observedAt: "2026-09-04T12:00:00Z",
  displayState,
});

function drawn(displayState) {
  const rows = keyRows({ status: { sources: [source()], samples: [sample(displayState)] } }, "2026-09-04T12:05:00Z");
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderKeys(doc, mount, rows, { markFor: () => "", save: async () => ({ ok: true }), refresh: async () => ({ ok: true }), remove: async () => ({ ok: true }) });
  return { row: rows.find((entry) => entry.provider === "openai"), text: mount.all((node) => node.dataset.keyRow === "openai")[0].textContent };
}

test("a state with no amount field shows no dollar sign, whatever field a future bug carried one in", () => {
  for (const state of [{ kind: "capped", ceilingUsd: "100", amountUsd: 412 }, { kind: "somethingNew", amount: "9.99" }]) {
    const { row, text } = drawn(state);
    assert.equal(row.state, "reading");
    assert.equal(row.amount, undefined, JSON.stringify(state));
    assert.equal(text.includes("$"), false, text);
    assert.doesNotMatch(text, /412|9\.99|100/u);
  }
});

test("a tracked state shows exactly the amount Rust decided, with its period", () => {
  const { text } = drawn({ kind: "tracked", amountUsd: "473.22", percentOfBudget: null });
  assert.match(text, /\$473\.22spent this month/u);
});
