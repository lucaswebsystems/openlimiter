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

test("the phone stacked layout is opt in and leaves the existing 30rem block unchanged", () => {
  const style = block("PROVIDER_ROW_STYLE");
  const start = style.indexOf("@container (max-width: 30rem)");
  const end = style.indexOf("\n}", start) + 2;
  const expected = `@container (max-width: 30rem) {
  .identity {
    min-height: 0;
    grid-template-columns: minmax(0, 1fr) 2rem;
    padding: 0;
    border: 0;
  }
  .identity-name {
    grid-column: 1;
    display: grid;
    grid-template-columns: 1.75rem minmax(0, 1fr);
    column-gap: var(--ol-space-2);
    row-gap: 0.125rem;
  }
  .mark { grid-column: 1; grid-row: 1 / 3; }
  .provider-name,
  .account-label { grid-column: 2; }
  .windows { gap: var(--ol-space-2); }
  .identity,
  .window-line { gap: var(--ol-space-2); }
  .window-line {
    grid-template-columns: minmax(4.25rem, 0.9fr) minmax(3rem, 1.25fr) minmax(max-content, 3rem) minmax(max-content, 3.5rem);
    column-gap: 0.375rem;
  }
  .column-label { display: none; }
  ::slotted([slot="actions"]) { grid-column: 2; }
  .account-label { display: block; }
  .window-name,
  .window-percent { font-size: var(--ol-text-micro); }
  .band-icon svg { width: 0.75rem; height: 0.75rem; }
  .window-reset { font-size: var(--ol-text-micro); }
}`;
  assert.equal(style.slice(start, end), expected);
  assert.match(style, /:host\(\[data-layout="stacked"\]\) \.window-line/u);
  assert.match(style, /:host\(\[data-layout="stacked"\]\) \.window-name \{[^}]*overflow: visible;[^}]*white-space: normal;/su);
  assert.match(style, /:host\(\[data-layout="stacked"\]\) \.window-percent \{ overflow: visible; text-overflow: clip; \}/u);
  assert.doesNotMatch(style.slice(end), /(^|\n)\.window-line \{/u);
});
