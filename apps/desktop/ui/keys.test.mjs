import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  KEY_CONSENT,
  KEY_PROVIDERS,
  keyError,
  keyRepaintGate,
  keyRows,
  periodLabel,
  renderKeys,
  saveOpenrouterConnection,
} from "./pro.js";
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
    saveOpenrouter: async (secret, recordId) => { calls.push(["openrouter", secret, recordId]); return { ok: true }; },
    save: async (input) => { calls.push(["spend", input]); return { ok: true }; },
    refresh: async (row) => { calls.push(["refresh", row.provider]); return { ok: true }; },
    remove: async (row) => { calls.push(["remove", row.provider]); return { ok: true }; },
    ...overrides,
  };
  renderKeys(doc, mount, rows, handlers);
  const row = (provider, index = 0) => mount.all((node) => node.dataset.keyRow === provider)[index];
  const field = (provider, name = "secret") => row(provider).all((node) => node.localName === "input" && node.dataset.field === name)[0];
  const save = (provider) => row(provider).all((node) => node.localName === "button" && node.dataset.keyAction === "save")[0];
  return { doc, mount, calls, handlers, row, field, save };
}

test("seven rows, including both OpenRouter credentials, each empty with a short placeholder, Save and a Get key link, under one consent line", () => {
  const rows = keyRows({}, NOW);
  assert.deepEqual(rows.map((row) => row.provider), ["openrouter", "openrouter", "openai", "anthropic", "xai", "moonshot", "deepseek"]);
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
  assert.equal(row("openrouter", 1).all((node) => node.localName === "input" && node.dataset.field === "secret")[0].getAttribute("placeholder"), "Management key");
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
  assert.deepEqual(calls, [["openrouter", "sk-or-example", undefined]]);
  assert.equal(field("openrouter").value, "", "the field is cleared the moment it is sent");
});

test("replacing a refused OpenRouter account keeps the healthy account", async () => {
  const records = new Set(["healthy", "refused"]);
  const actions = [];
  const rows = keyRows({
    openrouter: {
      records: [
        { id: "refused", provider: "OPENROUTER", state: "NEEDS_AUTH" },
        { id: "healthy", provider: "OPENROUTER", state: "CONNECTED" },
      ],
      readings: [],
    },
  }, NOW);
  const drawn = draw(rows, {
    saveOpenrouter: (secret, recordId) => saveOpenrouterConnection(secret, recordId, {
      save: async () => { actions.push(["save", secret]); records.add("replacement"); return { ok: true }; },
      replace: async (id) => { actions.push(["replace", id, secret]); return { ok: true }; },
    }),
  });
  drawn.field("openrouter").value = "sk-or-replacement";
  await drawn.save("openrouter").fire("click");
  assert.deepEqual(actions, [["replace", "refused", "sk-or-replacement"]]);
  assert.deepEqual([...records], ["healthy", "refused"]);
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  const connections = readFileSync(new URL("./connections.js", import.meta.url), "utf8");
  const backend = readFileSync(new URL("./backend.js", import.meta.url), "utf8");
  assert.match(app, /replace:\s*replaceOpenrouterKey/u);
  assert.match(connections, /backend\.replaceConnectionSecret\(recordId, secret\)/u);
  assert.match(backend, /call\("replace_connection_secret"/u);
});

test("a rejected OpenRouter replacement keeps the old account", async () => {
  const records = new Set(["healthy", "refused"]);
  const actions = [];
  const result = await saveOpenrouterConnection("sk-or-rejected", "refused", {
    save: async () => { actions.push("save"); return { ok: false, kind: "ineligible_or_revoked" }; },
    replace: async () => { actions.push("replace"); return { ok: false, kind: "ineligible_or_revoked" }; },
  });
  assert.deepEqual(result, { ok: false, kind: "ineligible_or_revoked" });
  assert.deepEqual(actions, ["replace"]);
  assert.deepEqual([...records], ["healthy", "refused"]);
});

test("adding an OpenRouter key keeps an existing paused account", async () => {
  const records = new Set(["paused"]);
  const removed = [];
  const rows = keyRows({
    openrouter: {
      records: [{ id: "paused", provider: "OPENROUTER", state: "CONNECTED", active: false }],
      readings: [],
    },
  }, NOW);
  const drawn = draw(rows, {
    saveOpenrouter: (secret, recordId) => saveOpenrouterConnection(secret, recordId, {
      save: async () => { records.add("new"); return { ok: true }; },
      replace: async (id) => { removed.push(id); return { ok: true }; },
    }),
  });
  drawn.field("openrouter").value = "sk-or-new";
  await drawn.save("openrouter").fire("click");
  assert.deepEqual(removed, []);
  assert.deepEqual([...records], ["paused", "new"]);
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

test("a successful xAI Save ends its edit and requests a repaint", async () => {
  const repainted = [];
  const drawn = draw(keyRows({}, NOW), {
    saved: async (row) => { repainted.push([row.provider, drawn.field("xai", "team").value]); },
  });
  drawn.field("xai").value = "xai-example";
  drawn.field("xai", "team").value = "team-123";
  drawn.field("xai", "team").focus();
  await drawn.save("xai").fire("click");
  assert.equal(drawn.doc.activeElement, null);
  assert.deepEqual(repainted, [["xai", "team-123"]]);
});

test("leaving the window keeps a typed key and its queued repaint", async () => {
  const drawn = draw(keyRows({}, NOW));
  const editing = drawn.field("openai");
  editing.value = "sk-admin-pasted";
  await editing.focus();
  let repaints = 0;
  const requestRepaint = keyRepaintGate(drawn.doc, drawn.mount);
  requestRepaint(() => { repaints += 1; });
  drawn.doc.hasFocus = () => false;
  await drawn.mount.fire("focusout", { relatedTarget: null });
  assert.equal(repaints, 0, "a window switch does not repaint over the typed key");
  assert.equal(editing.value, "sk-admin-pasted");
  drawn.doc.hasFocus = () => true;
  await drawn.mount.fire("focusout", { relatedTarget: null });
  assert.equal(repaints, 1, "the queued repaint runs once focus really leaves");
});

test("a repaint request leaves the focused key section untouched, then focusout repaints it once", async () => {
  const drawn = draw(keyRows({}, NOW));
  const originalChildren = [...drawn.mount.children];
  const editing = drawn.field("openai");
  editing.value = "sk-admin-being-edited";
  await editing.focus();
  const next = keyRows({
    status: status([source(FIRST, "xai", { status: "pending_validation", lastObservedAt: null })]),
  }, NOW);
  let repaints = 0;
  const requestRepaint = keyRepaintGate(drawn.doc, drawn.mount);
  assert.equal(requestRepaint(() => {
    repaints += 1;
    renderKeys(drawn.doc, drawn.mount, next, drawn.handlers);
  }), false);
  assert.deepEqual(drawn.mount.children, originalChildren, "no node in the section moves while its input has focus");
  assert.equal(drawn.doc.activeElement, editing);
  assert.equal(editing.value, "sk-admin-being-edited");
  assert.equal(repaints, 0);
  const nextInput = drawn.field("xai", "team");
  await nextInput.focus();
  assert.equal(repaints, 0, "moving between inputs inside the section does not flush the repaint");
  assert.equal(drawn.doc.activeElement, nextInput);
  await nextInput.blur();
  assert.equal(repaints, 1);
  assert.equal(drawn.doc.activeElement, null);
  assert.equal(drawn.field("xai"), undefined, "the submitted xAI row repaints after focus leaves");
  await drawn.mount.fire("focusout", { relatedTarget: null });
  assert.equal(repaints, 1, "the queued repaint is consumed only once");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /requestKeyRepaint\(\(\) => \{[\s\S]*?renderKeys\(document, elements\.keyRows, rows, keyHandlers\)/u);
  assert.doesNotMatch(app, /preserveRows|insertBefore|querySelectorAll\("\[data-key-id\]"\)/u);
});

test("a successful xAI Save repaints while its kept Team ID cannot block the section", async () => {
  const drawn = draw(keyRows({}, NOW));
  const next = keyRows({
    status: status([source(FIRST, "xai", { status: "pending_validation", lastObservedAt: null })]),
  }, NOW);
  const requestRepaint = keyRepaintGate(drawn.doc, drawn.mount);
  const team = drawn.field("xai", "team");
  drawn.field("xai").value = "xai-example";
  team.value = "team-123";
  await team.focus();
  drawn.handlers.saved = async () => {
    requestRepaint(() => renderKeys(drawn.doc, drawn.mount, next, drawn.handlers));
  };
  await drawn.save("xai").fire("click");
  assert.equal(team.value, "team-123", "the submitted Team ID stayed in the old row until repaint");
  assert.equal(drawn.doc.activeElement, null);
  assert.equal(drawn.field("xai"), undefined, "Save repainted xAI into its checking state");
  const app = readFileSync(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /saved: async \(\) => \{\s*drawnKeys = "";\s*await refresh\(\);/u);
  assert.doesNotMatch(app, /input\.value !== ""/u);
  assert.doesNotMatch(readFileSync(new URL("./pro.js", import.meta.url), "utf8"), /team\.value = ""/u);
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
  assert.equal(pending.find((row) => row.provider === "openai").state, "checking");
  const first = draw(pending);
  assert.equal(first.row("openai").textContent.includes("Checking key"), true);
  assert.equal(first.field("openai"), undefined, "no field while a key is being checked");

  const read = keyRows({ status: status([source(FIRST, "openai")], [sample(FIRST, "openai", "12.34")]) }, NOW);
  assert.equal(read.find((row) => row.provider === "openai").state, "reading");
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
  const replaced = rows.find((row) => row.provider === "openai");
  assert.deepEqual([replaced.state, replaced.amount], ["checking", undefined]);
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

test("OpenRouter's row reads its credits connection: checking, then the account balance with its age", () => {
  const checking = keyRows({ openrouter: { records: [{ id: "c1", provider: "OPENROUTER", state: "READY_TO_ENABLE", readerId: "openrouter_credits" }], readings: [] } }, NOW).find((row) => row.credentialKind === "openrouter_management_key");
  assert.deepEqual([checking.kind, checking.state], ["quota", "checking"]);
  const reading = {
    provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", value: 25, usedAmount: 12.5, limitAmount: 50, currency: "USD",
    observedAt: "2026-09-29T11:58:00.000Z", accountId: "c1",
  };
  const read = keyRows({ openrouter: { records: [{ id: "c1", provider: "OPENROUTER", state: "CONNECTED", readerId: "openrouter_credits" }], readings: [reading] } }, NOW);
  const management = read.find((row) => row.credentialKind === "openrouter_management_key");
  assert.deepEqual([management.state, management.amount, management.period], ["reading", "$37.50", "Account balance"]);
  const text = draw([management]).row("openrouter").textContent;
  for (const part of ["$37.50", "balance", "USD", "Updated 2 min ago"]) assert.ok(text.includes(part), part);
  const refused = keyRows({ openrouter: { records: [{ id: "c1", provider: "OPENROUTER", state: "NEEDS_AUTH", readerId: "openrouter_credits" }], readings: [] } }, NOW).find((row) => row.credentialKind === "openrouter_management_key");
  assert.deepEqual([refused.state, refused.error, refused.replace], ["error", "Key not accepted, paste a new one", true]);
  // Its field is right there, so the tool row's Connect has somewhere to go.
  const drawn = draw([refused]);
  assert.equal(drawn.field("openrouter").getAttribute("placeholder"), "Management key");
});

test("OpenRouter key allowance never borrows the account balance identity", () => {
  const record = { id: "c1", provider: "OPENROUTER", state: "CONNECTED", readerId: "openrouter_key" };
  const rows = keyRows({ openrouter: { records: [record], readings: [{
    provider: "OPENROUTER", meter: "KEY_LIMIT", value: 10, usedAmount: 10, limitAmount: 100,
    currency: "USD", observedAt: "2026-09-29T11:57:00.000Z", accountId: "c1",
  }, {
    provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", value: 38.3, usedAmount: 7.66, limitAmount: 20,
    currency: "USD", observedAt: "2026-09-29T11:59:00.000Z", accountId: "c1",
  }] } }, NOW);
  const inference = rows.find((row) => row.credentialKind === "openrouter_inference_key");
  assert.deepEqual([inference.amount, inference.period], ["$90.00", "Key allowance"]);
  assert.equal(draw([inference]).row("openrouter").textContent.includes("$12.34"), false);
});

test("two OpenRouter accounts each show, refresh and remove their own, and a paused one shows none", async () => {
  const record = (id, active = true) => ({ id, provider: "OPENROUTER", state: "CONNECTED", active, maskedLabel: "sk-or-v1-..." + id, readerId: "openrouter_credits" });
  const reading = (accountId, usedAmount, observedAt) => ({
    provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", value: 0, usedAmount, limitAmount: 50, currency: "USD", observedAt, accountId,
  });
  const records = [record("acct-a"), record("acct-b"), record("acct-paused", false)];
  // The paused account's reading is the newest, so a pick across accounts would show it everywhere.
  const readings = [
    reading("acct-a", 40, "2026-09-29T11:50:00.000Z"),
    reading("acct-b", 30, "2026-09-29T11:55:00.000Z"),
    reading("acct-paused", 1, "2026-09-29T11:59:00.000Z"),
  ];
  const rows = keyRows({ openrouter: { records, readings } }, NOW).filter((row) => row.kind === "quota" && row.recordId !== undefined);
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
  const unread = keyRows({ openrouter: { records: [record("acct-c")], readings } }, NOW).find((row) => row.recordId === "acct-c");
  assert.deepEqual([unread.recordId, unread.state, unread.amount], ["acct-c", "saved", undefined]);
  // A paused connection alone has no row to read, refresh or remove.
  const paused = keyRows({ openrouter: { records: [record("acct-paused", false)], readings } }, NOW)[0];
  assert.deepEqual([paused.state, paused.recordId, paused.amount], ["empty", undefined, undefined]);
});
