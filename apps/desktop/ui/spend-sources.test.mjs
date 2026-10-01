import assert from "node:assert/strict";
import test from "node:test";

/**
 * Samples belong to a source, never to a provider. Two saved OpenRouter keys
 * are two accounts, so each card shows its own newest reading, through the
 * real renderSpend against a scripted backend.
 */

const FIRST = "b28c9d51-7f0a-4c3e-9d64-5a1b8e2f7c03";
const SECOND = "c39dae62-8f1b-4d4f-8e75-6b2c9f3a8d14";

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

/* backend.js reads the runtime once, at import, so the script is swapped
   underneath one fixed runtime rather than a new window per test. */
let current = null;
globalThis.window = {
  __TAURI__: {
    core: {
      async invoke(command) {
        if (command === "api_spend_status") return current;
        throw new Error("Unexpected command " + command);
      },
    },
  },
};
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };
const { renderSpend } = await import("./pro.js");

async function render(status) {
  current = status;
  const mount = { innerHTML: "" };
  await renderSpend(mount);
  return mount.innerHTML;
}

const cards = (html) =>
  html
    .split('<article class="spend-source"')
    .slice(1)
    .map((card) => "<article" + card.split("</article>")[0]);

test("two sources of one provider render their own amounts, each from its newest sample", async () => {
  const html = await render({
    version: 1,
    localDisplayIsFree: true,
    sources: [source(FIRST, "Personal"), source(SECOND, "Work")],
    samples: [
      sample(FIRST, "1.11", "2026-09-07T09:00:00Z"),
      sample(SECOND, "22.20", "2026-09-07T11:00:00Z"),
      sample(FIRST, "3.33", "2026-09-07T12:00:00Z"),
    ],
  });
  const [first, second] = cards(html);
  assert.ok(first.includes("Personal") && second.includes("Work"), html);
  assert.match(first, /\$3\.33/u);
  assert.equal(first.includes("22.20") || first.includes("1.11"), false, first);
  assert.match(second, /\$22\.20/u);
  assert.equal(second.includes("3.33") || second.includes("1.11"), false, second);
});

test("a source with no sample of its own shows no reading, never a sibling's money", async () => {
  const html = await render({
    version: 1,
    localDisplayIsFree: true,
    sources: [source(FIRST, "Personal"), source(SECOND, "Work", { lastObservedAt: null })],
    samples: [sample(FIRST, "3.33", "2026-09-07T12:00:00Z")],
  });
  const [first, second] = cards(html);
  assert.match(first, /\$3\.33/u);
  assert.match(second, />no reading</u);
  assert.equal(second.includes("3.33"), false, second);
});

test("DeepSeek is a provider choice, and its balance states render without a converted amount", async () => {
  const deepseek = (id, status) =>
    source(id, "DeepSeek key", { provider: "deepseek", metricKind: "balance", status });
  const html = await render({
    version: 1,
    localDisplayIsFree: true,
    sources: [deepseek(FIRST, "reported_in_cny"), deepseek(SECOND, "too_low_for_api_calls")],
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
  assert.match(html, /<option value="deepseek">DeepSeek<\/option>/u);
  const [cny, low] = cards(html);
  assert.match(cny, /DeepSeek/u);
  assert.match(cny, /Reported in CNY/u);
  assert.equal(cny.includes("$"), false, cny);
  assert.match(low, /\$0\.4/u);
  assert.match(low, /Too low for API calls/u);
  for (const card of [cny, low]) {
    const text = card.replaceAll(/<[^>]*>/gu, " ");
    assert.equal(/[-‐-―]/u.test(text), false, text);
  }
});
