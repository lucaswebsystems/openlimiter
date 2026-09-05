import assert from "node:assert/strict";
import test from "node:test";

import { sourceMarkup } from "./pro.js";

/**
 * Founder decision 16, 2026-09-04. Rust decides the displayState; this file
 * only proves the renderer honours it, never recomputes an amount on its
 * own, and reaches for nothing else when a card is capped.
 */

const source = (overrides = {}) => ({
  id: "spend-source-1",
  provider: "openai",
  keyLabel: "Org admin",
  lastFour: "ab12",
  metricKind: "spend",
  status: "eligible",
  budgetUsd: null,
  lastObservedAt: "2026-09-04T12:00:00Z",
  ...overrides,
});

const trackedSample = (amountUsd, percentOfBudget = null) => ({
  provider: "openai",
  completeness: "complete",
  forecastDate: null,
  displayState: { kind: "tracked", amountUsd, percentOfBudget },
});

const cappedSample = () => ({
  provider: "openai",
  completeness: "complete",
  forecastDate: null,
  displayState: { kind: "capped", ceilingUsd: "100" },
});

test("a capped sample renders the hatched full bar, 100 plus, and an upgrade action, never a dollar sign", () => {
  const html = sourceMarkup(source(), cappedSample());
  assert.match(html, />100 plus</u);
  assert.match(html, /Pro keeps tracking\./u);
  assert.match(html, /data-spend-upgrade="spend-source-1"[^>]*>Upgrade</u);
  assert.match(html, /class="spend-budget" data-band="capped"/u);
  assert.match(html, /spend-budget-fill" data-band="capped"><\/span>/u);
  assert.equal(html.includes("style="), false, html);
  assert.equal(html.includes("$"), false, html);
});

test("a tracked sample under the ceiling still shows the real dollar figure and its budget bar", () => {
  const html = sourceMarkup(source({ budgetUsd: "50" }), trackedSample("42.10"));
  assert.match(html, /\$42\.10/u);
  assert.equal(html.includes("100 plus"), false);
  assert.equal(html.includes("Pro keeps tracking"), false);
  assert.equal(html.includes("data-spend-upgrade"), false);
});

test("an entitled reading past the ceiling shows the real amount, not 100 plus", () => {
  const html = sourceMarkup(source(), trackedSample("473.22"));
  assert.match(html, /\$473\.22/u);
  assert.equal(html.includes("100 plus"), false);
});

test("a leaked amount on a capped payload never reaches the markup, whatever field it rides in", () => {
  /* displayState is structurally amount free when capped (Capped has no
     amountUsd field on the Rust side), but this proves the renderer itself
     never goes looking for one on a neighbouring field either, in case a
     future bug ever attached one next to the tag it does not belong on. */
  const leaking = {
    provider: "openai",
    completeness: "complete",
    forecastDate: null,
    spendUsd: "473.22",
    amountUsd: "473.22",
    displayState: { kind: "capped", ceilingUsd: "100", amountUsd: "473.22" },
  };
  const html = sourceMarkup(source(), leaking);
  assert.equal(html.includes("473.22"), false, html);
  assert.match(html, />100 plus</u);
});

test("a balance sample never shows the upgrade action or the ceiling copy", () => {
  const html = sourceMarkup(
    source({ provider: "moonshot", metricKind: "balance", budgetUsd: null }),
    {
      provider: "moonshot",
      completeness: "complete",
      forecastDate: null,
      displayState: { kind: "balance", amountUsd: "812.40" },
    },
  );
  assert.match(html, /\$812\.40/u);
  assert.equal(html.includes("data-spend-upgrade"), false);
  assert.equal(html.includes("Pro keeps tracking"), false);
  assert.equal(html.includes("100 plus"), false);
});

test("no reading yet still renders honestly, with no bar and no cap copy", () => {
  const html = sourceMarkup(source(), null);
  assert.match(html, />no reading</u);
  assert.equal(html.includes("spend-budget"), false);
  assert.equal(html.includes("data-spend-upgrade"), false);
});

test("no copy in the capped card carries a dash", () => {
  const dashes = /[-‐-―]/u;
  const html = sourceMarkup(source(), cappedSample());
  const capBlock = html.slice(html.indexOf("100 plus"));
  assert.equal(dashes.test(capBlock.replaceAll(/<[^>]*>/gu, "")), false, capBlock);
});
