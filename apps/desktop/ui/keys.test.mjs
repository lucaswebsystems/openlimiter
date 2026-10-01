import assert from "node:assert/strict";
import test from "node:test";
import { KEY_CONSENT, KEY_PROVIDERS, keyError, keyRows, periodLabel, renderKeys } from "./pro.js";
import { fakeDocument, leaks, spoken } from "./test-dom.mjs";

/*
 * The API keys on the one screen: one row per provider, a field and Save when
 * empty, then the money with its real period. OpenRouter's field is the quota
 * connection; the other five are API spend sources.
 */

const NOW = "2026-09-29T12:00:00.000Z";
const FIRST = "b28c9d51-7f0a-4c3e-9d64-5a1b8e2f7c03";
const SECOND = "c39dae62-8f1b-4d4f-8e75-6b2c9f3a8d14";

const source = (id, provider, overrides = {}) => ({
  id, provider, keyLabel: provider, lastFour: "ab12", enabled: true, consentVersion: KEY_CONSENT.version,
  teamId: null, budgetUsd: null, lastObservedAt: "2026-09-29T11:58:00Z", nextAllowedAt: 0, status: "eligible",
  metricKind: ["moonshot", "deepseek"].includes(provider) ? "balance" : "spend", ...overrides,
});

const sample = (sourceId, provider, amountUsd, overrides = {}) => ({
  id: sourceId.slice(0, 8) + (overrides.observedAt ?? "2026-09-29T11:58:00Z"), sourceId, provider, keyLabel: provider,
  metricKind: ["moonshot", "deepseek"].includes(provider) ? "balance" : "spend", month: "2026-09-01",
  displayState: ["moonshot", "deepseek"].includes(provider) ? { kind: "balance", amountUsd } : { kind: "tracked", amountUsd, percentOfBudget: null },
  observedAt: "2026-09-29T11:58:00Z", sourcePeriod: "[2026-09-01T00:00:00Z, 2026-09-29T11:58:00Z)", forecastDate: null,
  completeness: ["moonshot", "deepseek"].includes(provider) ? "current_balance" : "complete", ...overrides,
});

const status = (sources = [], samples = []) => ({ version: 1, localDisplayIsFree: true, sources, samples });

function draw(rows, overrides = {}) {
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  const calls = [];
  const handlers = {
    markFor: () => "<svg></svg>",
    saveOpenrouter: async (secret) => { calls.push(["openrouter", secret]); return { ok: true }; },
    save: async (input) => { calls.push(["spend", input]); return { ok: true }; },
    refresh: async (row) => { calls.push(["refresh", row.provider]); return { ok: true }; },
    remove: async (row) => { calls.push(["remove", row.provider]); return { ok: true }; },
    ...overrides,
  };
  renderKeys(doc, mount, rows, handlers);
  const row = (provider, index = 0) => mount.all((node) => node.dataset.keyRow === provider)[index];
  const field = (provider, name = "secret") => row(provider).all((node) => node.localName === "input" && node.dataset.field === name)[0];
  const save = (provider) => row(provider).all((node) => node.localName === "button" && node.dataset.keyAction === "save")[0];
  return { doc, mount, calls, row, field, save };
}

test("six rows, each empty with a short placeholder, Save and a Get key link, under one consent line", () => {
  const rows = keyRows({}, NOW);
  assert.deepEqual(rows.map((row) => row.provider), ["openrouter", "openai", "anthropic", "xai", "moonshot", "deepseek"]);
  assert.ok(rows.every((row) => row.state === "empty"));
  const { mount, row, field, save } = draw(rows);
  const consent = mount.all((node) => node.id === "key-consent");
  assert.equal(consent.length, 1);
  assert.equal(consent[0].textContent, "Saving lets OpenLimiter check this provider's billing. Keys stay on this device.");
  assert.equal(mount.children[0], consent[0], "the line sits above the first Save");
  const placeholders = Object.fromEntries(KEY_PROVIDERS.map((provider) => [provider.id, field(provider.id).getAttribute("placeholder")]));
  assert.deepEqual(placeholders, {
    openrouter: "API key", openai: "Admin key", anthropic: "Admin key", xai: "Management key", moonshot: "API key", deepseek: "API key",
  });
  for (const provider of KEY_PROVIDERS) {
    assert.equal(field(provider.id).type, "password");
    assert.ok(field(provider.id).getAttribute("placeholder").split(" ").length <= 3);
    assert.equal(save(provider.id).textContent, "Save");
    const link = row(provider.id).all((node) => node.localName === "a")[0];
    assert.equal(link.textContent, "Get key");
    assert.match(link.getAttribute("href"), /^https:\/\//u);
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
  }
  assert.equal(field("xai", "team").getAttribute("placeholder"), "Team ID");
  assert.equal(field("openai", "team"), undefined);
  assert.deepEqual(leaks(spoken(mount)), []);
});

test("the OpenRouter Save creates the quota connection and never an API spend source", async () => {
  const { calls, field, save } = draw(keyRows({}, NOW));
  field("openrouter").value = "  sk-or-example  ";
  await save("openrouter").fire("click");
  assert.deepEqual(calls, [["openrouter", "sk-or-example"]]);
  assert.equal(field("openrouter").value, "", "the field is cleared the moment it is sent");
});

test("the other Saves send confirmed with the consent version on screen, the team for xAI, the source to replace", async () => {
  const { calls, field, save } = draw(keyRows({}, NOW));
  field("openai").value = "sk-admin-example";
  await save("openai").fire("click");
  field("xai").value = "xai-example";
  field("xai", "team").value = "team-123";
  await save("xai").fire("click");
  assert.deepEqual(calls, [
    ["spend", { provider: "openai", keyLabel: "OpenAI", secret: "sk-admin-example", consentVersion: KEY_CONSENT.version, confirmed: true }],
    ["spend", { provider: "xai", keyLabel: "xAI", secret: "xai-example", teamId: "team-123", consentVersion: KEY_CONSENT.version, confirmed: true }],
  ]);
  // A refused key is replaced on its own source, which keeps its history.
  const refused = keyRows({ status: status([source(FIRST, "anthropic", { status: "ineligible_or_revoked" })]) }, NOW);
  const again = draw(refused);
  again.field("anthropic").value = "sk-ant-admin-example";
  await again.save("anthropic").fire("click");
  assert.equal(again.calls[0][1].sourceId, FIRST);
  assert.equal(again.calls[0][1].confirmed, true);
  // Nothing typed, nothing sent.
  const empty = draw(keyRows({}, NOW));
  await empty.save("moonshot").fire("click");
  assert.deepEqual(empty.calls, []);
});

test("the period is the sample's real month: this month, last month, an older month, or a balance", () => {
  const spend = (month) => ({ metricKind: "spend", month });
  assert.equal(periodLabel(spend("2026-09-01"), NOW), "spent this month");
  assert.equal(periodLabel(spend("2026-08-01"), NOW), "last month");
  assert.equal(periodLabel(spend("2026-06-01"), NOW), "spent in June");
  assert.equal(periodLabel(spend("2025-12-01"), "2026-01-05T09:00:00.000Z"), "last month");
  assert.equal(periodLabel({ metricKind: "balance", month: "2026-01-01" }, NOW), "balance");
});

test("after Save a row checks the key, then shows the amount, its period, the currency and the age", async () => {
  const pending = keyRows({ status: status([source(FIRST, "openai", { status: "pending_validation", lastObservedAt: null })]) }, NOW);
  assert.equal(pending[1].state, "checking");
  const first = draw(pending);
  assert.equal(first.row("openai").textContent.includes("Checking key"), true);
  assert.equal(first.field("openai"), undefined, "no field while a key is being checked");

  const read = keyRows({ status: status([source(FIRST, "openai")], [sample(FIRST, "openai", "12.34")]) }, NOW);
  assert.equal(read[1].state, "reading");
  const { row, calls } = draw(read);
  const text = row("openai").textContent;
  for (const part of ["$12.34", "spent this month", "USD", "Updated 2 min ago"]) assert.ok(text.includes(part), part);
  assert.doesNotMatch(text, /Incomplete|Unavailable/u);
  const buttons = row("openai").all((node) => node.localName === "button");
  assert.deepEqual(buttons.map((button) => button.dataset.keyAction), ["refresh", "remove"]);
  await buttons[0].fire("click");
  assert.deepEqual(calls, [["refresh", "openai"]]);
});

test("a replaced key checks the new key and never shows the amount from before the replace", () => {
  const rows = keyRows({ status: status(
    [source(FIRST, "openai", { status: "pending_validation", lastObservedAt: null })],
    [sample(FIRST, "openai", "12.34")],
  ) }, NOW);
  assert.deepEqual([rows[1].state, rows[1].amount], ["checking", undefined]);
  const text = draw(rows).row("openai").textContent;
  assert.ok(text.includes("Checking key"));
  assert.equal(text.includes("12.34"), false);
});

test("Incomplete and Unavailable show only when true, and last month is never this month", () => {
  const incomplete = keyRows({ status: status([source(FIRST, "openai")], [sample(FIRST, "openai", "3", { completeness: "period_incomplete" })]) }, NOW);
  assert.match(draw(incomplete).row("openai").textContent, /Incomplete/u);
  const since = keyRows({ status: status([source(FIRST, "openai")], [sample(FIRST, "openai", "3", { completeness: "since_connected" })]) }, NOW);
  assert.match(draw(since).row("openai").textContent, /Incomplete/u);
  const down = keyRows({ status: status([source(FIRST, "openai", { status: "temporarily_unavailable" })], [sample(FIRST, "openai", "3")]) }, NOW);
  assert.match(draw(down).row("openai").textContent, /Unavailable/u);
  const old = keyRows({ status: status([source(FIRST, "anthropic")], [sample(FIRST, "anthropic", "40", { month: "2026-08-01" })]) }, NOW);
  const text = draw(old).row("anthropic").textContent;
  assert.match(text, /\$40\.00last month/u);
  assert.doesNotMatch(text, /this month|Incomplete|Unavailable/u);
});

test("each source shows its own newest sample, matched by source and never by provider", () => {
  const rows = keyRows({ status: status(
    [source(FIRST, "openai", { keyLabel: "Personal" }), source(SECOND, "openai", { keyLabel: "Work", lastObservedAt: null })],
    [sample(FIRST, "openai", "1.11", { observedAt: "2026-09-29T09:00:00Z" }), sample(FIRST, "openai", "3.33", { observedAt: "2026-09-29T11:58:00Z" })],
  ) }, NOW);
  const openai = rows.filter((row) => row.provider === "openai");
  assert.deepEqual(openai.map((row) => [row.sourceId, row.state, row.amount]), [[FIRST, "reading", "$3.33"], [SECOND, "checking", undefined]]);
  const { row } = draw(rows);
  assert.match(row("openai", 0).textContent, /Personal/u);
  assert.match(row("openai", 1).textContent, /Work/u);
  assert.equal(row("openai", 1).textContent.includes("3.33"), false);
});

test("balances: DeepSeek in yuan shows no amount, a low balance says so", () => {
  const rows = keyRows({ status: status(
    [source(FIRST, "deepseek"), source(SECOND, "moonshot", { status: "too_low_for_api_calls" })],
    [sample(FIRST, "deepseek", null, { displayState: { kind: "reportedInCny" } }), sample(SECOND, "moonshot", "0.4")],
  ) }, NOW);
  const { row } = draw(rows);
  assert.match(row("deepseek").textContent, /Reported in CNY/u);
  assert.equal(row("deepseek").textContent.includes("$"), false);
  assert.match(row("moonshot").textContent, /\$0\.40balance/u);
  assert.match(row("moonshot").textContent, /Too low for API calls/u);
});

test("errors are one short line that says what to do", async () => {
  assert.equal(keyError("openai", "ineligible_or_revoked"), "Project key won't work, use an Admin key");
  assert.equal(keyError("anthropic", "ineligible_or_revoked"), "Workspace key won't work, use an Admin key");
  assert.equal(keyError("xai", "invalid_input"), "Wrong team ID");
  assert.equal(keyError("deepseek", "ineligible_or_revoked"), "Key not accepted, paste a new one");
  const refused = keyRows({ status: status([source(FIRST, "openai", { status: "ineligible_or_revoked" })]) }, NOW);
  const drawn = draw(refused);
  assert.match(drawn.row("openai").textContent, /Project key won't work, use an Admin key/u);
  assert.ok(drawn.field("openai"), "a refused key can be replaced right there");
  // A refusal on Save lands on its own row.
  const failing = draw(keyRows({}, NOW), { save: async () => ({ ok: false, kind: "invalid_input" }) });
  failing.field("xai").value = "xai-example";
  failing.field("xai", "team").value = "nope";
  await failing.save("xai").fire("click");
  assert.match(failing.row("xai").textContent, /Wrong team ID/u);
  for (const provider of ["openai", "anthropic", "xai", "openrouter", "moonshot", "deepseek"]) {
    for (const kind of ["ineligible_or_revoked", "invalid_input", "keyring_unavailable", "rate_limited", "network", "storage"]) {
      const line = keyError(provider, kind);
      assert.ok(line.length <= 48, line);
      assert.doesNotMatch(line, /[-‐-―−]/u, line);
    }
  }
});

test("OpenRouter's row reads its quota connection: checking, then the balance with its age", () => {
  const checking = keyRows({ openrouter: { records: [{ id: "c1", provider: "OPENROUTER", state: "READY_TO_ENABLE" }], readings: [] } }, NOW)[0];
  assert.deepEqual([checking.kind, checking.state], ["quota", "checking"]);
  const reading = {
    provider: "OPENROUTER", meter: "CREDITS", value: 25, usedAmount: 12.5, limitAmount: 50, currency: "USD",
    observedAt: "2026-09-29T11:58:00.000Z", accountId: "c1",
  };
  const read = keyRows({ openrouter: { records: [{ id: "c1", provider: "OPENROUTER", state: "CONNECTED" }], readings: [reading] } }, NOW);
  assert.deepEqual([read[0].state, read[0].amount, read[0].period], ["reading", "$37.50", "balance"]);
  const text = draw(read).row("openrouter").textContent;
  for (const part of ["$37.50", "balance", "USD", "Updated 2 min ago"]) assert.ok(text.includes(part), part);
  const refused = keyRows({ openrouter: { records: [{ id: "c1", provider: "OPENROUTER", state: "NEEDS_AUTH" }], readings: [] } }, NOW)[0];
  assert.deepEqual([refused.state, refused.error, refused.replace], ["error", "Key not accepted, paste a new one", true]);
  // Its field is right there, so the tool row's Connect has somewhere to go.
  const drawn = draw([refused]);
  assert.equal(drawn.field("openrouter").getAttribute("placeholder"), "API key");
});

test("two OpenRouter accounts each show, refresh and remove their own, and a paused one shows none", async () => {
  const record = (id, active = true) => ({ id, provider: "OPENROUTER", state: "CONNECTED", active, maskedLabel: "sk-or-v1-..." + id });
  const reading = (accountId, usedAmount, observedAt) => ({
    provider: "OPENROUTER", meter: "CREDITS", value: 0, usedAmount, limitAmount: 50, currency: "USD", observedAt, accountId,
  });
  const records = [record("acct-a"), record("acct-b"), record("acct-paused", false)];
  // The paused account's reading is the newest, so a pick across accounts would show it everywhere.
  const readings = [
    reading("acct-a", 40, "2026-09-29T11:50:00.000Z"),
    reading("acct-b", 30, "2026-09-29T11:55:00.000Z"),
    reading("acct-paused", 1, "2026-09-29T11:59:00.000Z"),
  ];
  const rows = keyRows({ openrouter: { records, readings } }, NOW).filter((row) => row.kind === "quota");
  assert.deepEqual(rows.map((row) => [row.recordId, row.amount]), [["acct-a", "$10.00"], ["acct-b", "$20.00"]]);

  const calls = [];
  const act = (kind) => async (row) => { calls.push([kind, row.recordId]); return { ok: true }; };
  const drawn = draw(rows, { refresh: act("refresh"), remove: act("remove") });
  for (const index of [0, 1]) {
    const [refresh, remove] = drawn.row("openrouter", index).all((node) => node.localName === "button");
    await refresh.fire("click");
    await remove.fire("click");
    await remove.fire("click");
  }
  assert.deepEqual(calls, [["refresh", "acct-a"], ["remove", "acct-a"], ["refresh", "acct-b"], ["remove", "acct-b"]]);
  assert.match(drawn.row("openrouter", 0).textContent, /\$10\.00/u);
  assert.equal(drawn.row("openrouter", 0).textContent.includes("$20.00"), false);

  // An account with no reading of its own shows none of another's.
  const unread = keyRows({ openrouter: { records: [record("acct-c")], readings } }, NOW)[0];
  assert.deepEqual([unread.recordId, unread.state, unread.amount], ["acct-c", "saved", undefined]);
  // A paused connection alone has no row to read, refresh or remove.
  const paused = keyRows({ openrouter: { records: [record("acct-paused", false)], readings } }, NOW)[0];
  assert.deepEqual([paused.state, paused.recordId, paused.amount], ["empty", undefined, undefined]);
});
