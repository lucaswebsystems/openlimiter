import assert from "node:assert/strict";
import test from "node:test";
import { keyRows, renderKeys } from "./pro.js";
import { fakeDocument } from "./test-dom.mjs";

/**
 * Samples belong to a source, never to a provider. Two saved keys of one
 * provider are two accounts, so each row shows its own newest reading. A 2.0.2
 * OpenRouter spend source keeps its own rows under OpenRouter's key.
 */

const FIRST = "b28c9d51-7f0a-4c3e-9d64-5a1b8e2f7c03";
const SECOND = "c39dae62-8f1b-4d4f-8e75-6b2c9f3a8d14";
const NOW = "2026-09-07T12:05:00Z";

const source = (id, keyLabel, overrides = {}) => ({
  id,
  provider: "openrouter",
  keyLabel,
  lastFour: id.slice(-4),
  eligibilityClass: "management_key",
  enabled: true,
  consentVersion: 1,
  teamId: null,
  budgetUsd: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-07T12:00:00Z",
  lastObservedAt: "2026-09-07T12:00:00Z",
  nextAllowedAt: 0,
  status: "eligible",
  metricKind: "spend",
  ...overrides,
});

const sample = (sourceId, amountUsd, observedAt, overrides = {}) => ({
  id: sourceId.slice(0, 8) + observedAt,
  sourceId,
  provider: "openrouter",
  keyLabel: "key",
  metricKind: "spend",
  month: "2026-09-01",
  displayState: { kind: "tracked", amountUsd, percentOfBudget: null },
  observedAt,
  sourcePeriod: "[2026-09-01T00:00:00Z, " + observedAt + ")",
  forecastDate: null,
  completeness: "complete",
  ...overrides,
});

function render(status) {
  const rows = keyRows({ status: { version: 1, localDisplayIsFree: true, ...status } }, NOW);
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderKeys(doc, mount, rows, { markFor: () => "", save: async () => ({ ok: true }), saveOpenrouter: async () => ({ ok: true }), refresh: async () => ({ ok: true }), remove: async () => ({ ok: true }) });
  return { rows, cards: (provider) => mount.all((node) => node.dataset.keyRow === provider).map((node) => node.textContent) };
}

test("two sources of one provider render their own amounts, each from its newest sample", () => {
  const { cards } = render({
    sources: [source(FIRST, "Personal"), source(SECOND, "Work")],
    samples: [
      sample(FIRST, "1.11", "2026-09-07T09:00:00Z"),
      sample(SECOND, "22.20", "2026-09-07T11:00:00Z"),
      sample(FIRST, "3.33", "2026-09-07T12:00:00Z"),
    ],
  });
  // OpenRouter's two key rows precede its two source rows.
  const [inference, management, first, second] = cards("openrouter");
  assert.match(inference, /Save/u);
  assert.match(management, /Save/u);
  assert.ok(first.includes("Personal") && second.includes("Work"), first + second);
  assert.match(first, /\$3\.33/u);
  assert.equal(first.includes("22.20") || first.includes("1.11"), false, first);
  assert.match(second, /\$22\.20/u);
  assert.equal(second.includes("3.33") || second.includes("1.11"), false, second);
});

test("a source with no sample of its own is checking its key, never showing a sibling's money", () => {
  const { cards } = render({
    sources: [source(FIRST, "Personal"), source(SECOND, "Work", { lastObservedAt: null, status: "pending_validation" })],
    samples: [sample(FIRST, "3.33", "2026-09-07T12:00:00Z")],
  });
  const [, , first, second] = cards("openrouter");
  assert.match(first, /\$3\.33/u);
  assert.match(second, /Checking key/u);
  assert.equal(second.includes("3.33"), false, second);
});

test("DeepSeek has its own row, and its balance states render without a converted amount", () => {
  const deepseek = (id, status) =>
    source(id, "DeepSeek key", { provider: "deepseek", metricKind: "balance", status });
  const { cards } = render({
    sources: [deepseek(FIRST, "eligible"), deepseek(SECOND, "too_low_for_api_calls")],
    samples: [
      sample(FIRST, null, "2026-09-07T12:00:00Z", {
        provider: "deepseek",
        metricKind: "balance",
        displayState: { kind: "reportedInCny" },
        completeness: "current_balance",
      }),
      sample(SECOND, "0.4", "2026-09-07T12:00:00Z", {
        provider: "deepseek",
        metricKind: "balance",
        displayState: { kind: "balance", amountUsd: "0.4" },
        completeness: "current_balance",
      }),
    ],
  });
  const [cny, low] = cards("deepseek");
  assert.match(cny, /DeepSeek/u);
  assert.match(cny, /Reported in CNY/u);
  assert.equal(cny.includes("$"), false, cny);
  assert.match(low, /\$0\.40/u);
  assert.match(low, /Too low for API calls/u);
  for (const card of [cny, low]) assert.equal(/[-‐-―]/u.test(card), false, card);
});
