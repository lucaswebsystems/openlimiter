import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildProviderAccountRows, providerRowMarkup, providerTableHeaderMarkup } from "../../../packages/ui/dist/provider-row.js";

/*
 * Every class the shared row's stylesheet names must be drawn by the row's
 * markup. 2.0.1 carried a second, table shaped stylesheet under the one the
 * row actually uses; its narrow window grid areas outlived the one column
 * override and scattered the row at 520 pixels. This is the proof that no such
 * rule is left: a selector for a class nothing draws fails here.
 */
const source = readFileSync(new URL("../../../packages/ui/src/provider-row.ts", import.meta.url), "utf8");
const block = (name) => {
  const start = source.indexOf(`const ${name} = \``);
  assert.ok(start >= 0, `${name} is missing`);
  return source.slice(start, source.indexOf("`;", start));
};
const classesIn = (css) => new Set([...css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/gu, "")
  .matchAll(/\.([a-z][a-z0-9-]*)/gu)].map((match) => match[1]).filter((name) => !/^\d/u.test(name)));

const now = "2026-09-29T12:00:00.000Z";
const row = (meter, value, extra = {}) => ({
  provider: "CLAUDE", meter, value, unit: "PERCENT", window: { kind: "rolling", durationSeconds: 18_000 },
  resetAt: "2026-09-29T14:00:00.000Z", source: "internal_payload", precision: "exact",
  observedAt: "2026-09-29T11:58:00.000Z", expiresAt: "2026-09-29T12:10:00.000Z",
  labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint", automationRisk: "high", verification: "UNVERIFIED" },
  ...extra,
});
const markup = buildProviderAccountRows([
  row("FIVE_HOUR", 95, { accountId: "first" }),
  row("SEVEN_DAY", 20, { accountId: "second" }),
  row("SEVEN_DAY", 12, { provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", unit: "PERCENT", accountId: "second" }),
  row("SEVEN_DAY", 40, { expiresAt: "2026-09-29T11:59:00.000Z", accountId: "second" }),
], now, [], {
  providers: ["CLAUDE", "OPENROUTER"],
  updatedLabel: () => "Updated 2 min ago",
}).map(providerRowMarkup).join("") + providerTableHeaderMarkup();
const drawn = new Set([...markup.matchAll(/class="([^"]+)"/gu)].flatMap((match) => match[1].split(/\s+/u)));

test("every class the shared row styles is one its markup draws", () => {
  const dead = [...classesIn(block("PROVIDER_ROW_STYLE"))].filter((name) => !drawn.has(name));
  assert.deepEqual(dead, []);
});

test("the row keeps one grid: no template areas outlive the one column form", () => {
  const style = block("PROVIDER_ROW_STYLE");
  assert.doesNotMatch(style, /grid-template-areas|grid-area/u);
  assert.equal((style.match(/^\.row \{/gmu) ?? []).length, 1, "one .row rule");
  assert.doesNotMatch(block("PROVIDER_TABLE_HEADER_STYLE"), /\.table-head|grid-template/u);
});
