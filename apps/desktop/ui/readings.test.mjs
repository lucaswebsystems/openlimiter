import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeMetersReport, projectSnapshots } from "../../../packages/core/dist/index.js";
import { parseClaudePayload } from "../../../packages/connectors/dist/index.js";
import { messyFixtures, ACCOUNTS } from "./messy-fixtures.mjs";
import { agentName, meterLabel, providerCode, providerName, READINGS_COPY, say } from "./names.js";
import { fakeDocument, leaks, spoken } from "./test-dom.mjs";
// readings.js reaches the compiled engine, which only exists in the build.
import {
  attentionFlags, fixWords, holdReadings, inventoryModel, limitsKey, limitsModel, officialMark, patchLimits, projectReadings,
  renderLimits, splitInventory, timeLeft, updatedLabel,
} from "./dist/readings.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const now = new Date(NOW).toISOString();
const fixtures = messyFixtures(NOW);
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

test("splitInventory keeps measured bars separate and strips Usage actions", () => {
  const measured = { code: "CLAUDE", windows: [{ label: "Weekly" }], action: { label: "Connect" }, note: "old", extra: ["detail"] };
  const setup = { code: "KIMI", windows: [], action: { label: "Connect" }, note: null, extra: [] };
  const result = splitInventory([measured, setup]);
  assert.deepEqual(result.usage, [{ ...measured, action: null, note: null, extra: [] }]);
  assert.deepEqual(result.tools, [{ ...measured, windows: [], note: "old" }, setup]);
});

test("one case insensitive name for every provider code, from the registry", () => {
  for (const code of ["CLAUDE", "claude", "Claude"]) assert.equal(providerName(code), "Claude Code");
  for (const code of ["GEMINI_CLI", "gemini-cli", "gemini_cli"]) assert.equal(providerName(code), "Gemini CLI");
  assert.equal(providerName("CODEX"), "Codex");
  assert.equal(providerName("KIMI"), "Kimi");
  assert.equal(providerName("ANTIGRAVITY"), "Antigravity");
  assert.equal(providerName("OPENROUTER"), "OpenRouter");
  assert.equal(providerName("MANUAL"), "Manual");
  // The name Connections already lists, so one provider has one name everywhere.
  assert.equal(providerName("GROK"), "Grok (xAI)");
  assert.equal(providerName("SOME_NEW_TOOL"), "Some New Tool");
  assert.equal(providerCode(" gemini-cli "), "GEMINI_CLI");
});

test("meter codes read as words, and an unfamiliar code is read out of its parts", () => {
  const cases = [
    ["FIVE_HOUR", "CLAUDE", "Current session"], ["five_hour", "KIMI", "5 hour limit"], ["SEVEN_DAY", "CODEX", "Weekly"],
    ["SEVEN_DAY", "CLAUDE", "Weekly, all models"], ["SEVEN_DAY_FABLE", "CLAUDE", "Weekly, Fable"],
    ["SEVEN_DAY_FABLE_5_1", "CLAUDE", "Weekly, Fable"], ["SEVEN_DAY_OPUS", "CLAUDE", "Weekly, Opus"],
    ["SEVEN_DAY_HAIKU_4_5", "CLAUDE", "Weekly, Haiku 4.5"], ["SEVEN_DAY_OAUTH_APPS", "CLAUDE", "Weekly, OAuth Apps"],
    ["FIVE_HOUR_2", "CLAUDE", "5 hour 2"], ["PRIMARY", "CODEX", "Primary window"], ["CREDITS", "OPENROUTER", "Credits"],
    ["MONTHLY_CREDIT_LIMIT", "CODEX", "Monthly credit limit"], ["ACCOUNT_BALANCE", "OPENROUTER", "Account balance"],
    ["KEY_LIMIT", "OPENROUTER", "Key allowance"], ["WEEKLY", "KIMI", "Weekly limit"],
    ["FIVE_HOUR", "OPENCODE", "5 hour limit, from the OpenCode page"],
    ["GEMINI_3_1_PRO_PREVIEW", "GEMINI_CLI", "Gemini 3.1 Pro Preview"], ["BRAND_NEW_WINDOW", "CLAUDE", "Brand new window"],
    ["MONTHLY", "SOMEONE", "Monthly"],
  ];
  for (const [code, provider, label] of cases) assert.equal(meterLabel(code, provider), label, code);
  assert.deepEqual(leaks(cases.map(([code, provider]) => meterLabel(code, provider))), []);
  assert.equal(agentName("claude_code"), "Claude Code");
  assert.equal(agentName("unknown"), null);
});

test("affected meters keep shared meanings and ordering in the desktop model", () => {
  const base = fixtures.projected.snapshots[0];
  const rows = [
    { ...base, provider: "KIMI", meter: "FIVE_HOUR", value: 80 },
    { ...base, provider: "KIMI", meter: "WEEKLY", value: 20 },
    { ...base, provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", value: 25, usedAmount: 12.5, limitAmount: 50, currency: "USD", window: { kind: "lifetime" }, resetAt: null },
    { ...base, provider: "CURSOR", meter: "AUTO", value: 90 },
  ];
  const model = limitsModel(projectSnapshots(rows, now).snapshots, now);
  const kimi = model.find((provider) => provider.code === "KIMI");
  const balance = model.find((provider) => provider.code === "OPENROUTER")?.windows[0];
  assert.deepEqual(kimi?.windows.map((window) => [window.label, window.value]), [
    ["Weekly limit", "20%"], ["5 hour limit", "80%"],
  ]);
  assert.deepEqual([balance?.label, balance?.value, balance?.band], ["Account balance", "$37.50", "none"]);
  assert.equal(model.some((provider) => provider.code === "CURSOR"), false);
});

test("a reserved or id shaped meter code reads as the neutral Limit, never as itself", () => {
  for (const code of ["UNKNOWN", "UNKNOWN_WINDOW", "NULL", "A1B2C3D4E5F60718", "PLAN_4B1D4B1D0123", "X_ABCDEFGHIJKLMNOPQRS"]) {
    assert.equal(meterLabel(code, "MANUAL"), "Limit", code);
  }
  // Ordinary codes with numbers in them still read as words.
  assert.equal(meterLabel("TEAM_PLAN", "MANUAL"), "Team plan");
  assert.equal(meterLabel("SEVEN_DAY_HAIKU_4_5", "CLAUDE"), "Weekly, Haiku 4.5");
  assert.equal(meterLabel("DEADBEEF", "MANUAL"), "Deadbeef");
  // The bar's aria label is the meter label, so it is neutral too.
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  const row = { ...fixtures.projected.snapshots[0], provider: "MANUAL", meter: "A1B2C3D4E5F60718" };
  renderLimits(doc, mount, limitsModel([row], now));
  assert.deepEqual(leaks(spoken(mount)), []);
  assert.ok(spoken(mount).includes("Limit"));
});

test("the projected payload is exactly what the one projection makes of the raw cache", () => {
  const raw = normalizeMetersReport(fixtures.raw.snapshots);
  assert.equal(raw.rejected.length, 0);
  const projected = projectSnapshots(raw.snapshots, now, fixtures.active);
  assert.deepEqual(projected.snapshots.map((row) => [row.provider, row.meter, row.value]),
    fixtures.projected.snapshots.map((row) => [row.provider, row.meter, row.value]));
  // Native adds the detection and switch flags the webview cannot see.
  const native = new Set(fixtures.projected.flags.map((flag) => [flag.provider, flag.accountId, flag.reason].join()));
  for (const flag of projected.flags) assert.ok(native.has([flag.provider, flag.accountId, flag.reason].join()), flag.provider);
});

test("every row the webview draws passes the projection, native rows included", () => {
  const projected = projectReadings(JSON.stringify(fixtures.projected), null, now);
  assert.equal(projected.snapshots.length, 5);
  assert.equal(projected.flags.length, fixtures.projected.flags.length);
  // A raw cache cannot bring a stale, placeholder or unavailable row back.
  const raw = projectReadings(JSON.stringify(fixtures.raw), "", now);
  assert.ok(raw.snapshots.every((row) => row.meter !== "ACQUISITION" && row.availability === undefined));
  assert.ok(raw.snapshots.every((row) => Date.parse(row.observedAt) > NOW - 3_600_000));
  assert.deepEqual([...new Set(raw.snapshots.map((row) => row.provider))].sort(), ["CLAUDE", "CODEX", "OPENROUTER"]);
  // The manual document never passed through native code, so it goes through here.
  const manual = JSON.stringify({ meters: [{ name: "TEAM_PLAN", used_percent: 40, reset_at: "2026-09-30T12:00:00.000Z" }] });
  const typed = projectReadings(null, manual, now);
  assert.equal(typed.snapshots[0].provider, "MANUAL");
  assert.equal(limitsModel(typed.snapshots, now)[0].windows[0].label, "Team plan");
  assert.deepEqual(projectReadings(null, "{not json", now).failures, [{ provider: "MANUAL", category: "PAYLOAD_UNREADABLE" }]);
});

test("each unmeasured provider keeps its most useful fix, never one Home measures or one switched off", () => {
  const readings = projectReadings(JSON.stringify(fixtures.projected), null, now);
  const flags = attentionFlags(readings.flags, readings.snapshots);
  assert.deepEqual(flags.map((flag) => [flag.provider, flag.fixKind]), [
    ["GROK", "sign_in"], ["OPENCODE", "reconnect"],
    ["ANTIGRAVITY", "open_app"], ["KIMI", "open_app"], ["GEMINI_CLI", "unsupported"],
  ]);
  // A switch off is a choice: that provider leaves the group whatever else it flags.
  assert.deepEqual(attentionFlags([
    { provider: "GROK", reason: "disabled", fixKind: "switch_on" },
    { provider: "GROK", reason: "missing_credentials", fixKind: "sign_in" },
  ], []), []);
  assert.deepEqual(attentionFlags([{ provider: "KIMI", reason: "stale", fixKind: "open_app" }], [], ["KIMI"]), []);
  // Two flags for one provider become its most useful fix.
  assert.deepEqual(attentionFlags([
    { provider: "KIMI", reason: "placeholder", fixKind: "unsupported" },
    { provider: "KIMI", reason: "expired_credentials", fixKind: "open_app" },
  ], []).map((flag) => flag.fixKind), ["open_app"]);
});

test("retired Gemini consumer plans keep the unavailable state and explain why", () => {
  const model = inventoryModel({
    flags: [{ provider: "GEMINI_CLI", reason: "quota_unavailable", fixKind: "unsupported" }]
  }, now);
  const gemini = model.find((tool) => tool.code === "GEMINI_CLI");
  assert.equal(gemini?.note, "Google ended Gemini CLI sign in for this plan on June 18, 2026.");
  assert.equal(gemini?.windows.length, 0);
});

test("the list holds what is measured, detected, keyed or flagged, never a switched off tool", () => {
  const readings = projectReadings(JSON.stringify(fixtures.projected), null, now);
  const detections = { providers: [
    { provider_id: "gemini-cli", state: "present" }, { provider_id: "cursor", state: "present" },
    { provider_id: "grok", state: "installed_logged_out" }, { provider_id: "kimi", state: "absent" },
  ] };
  const connections = [{ provider: "opencode", state: "CONNECTED" }, { provider: "antigravity", state: "NEEDS_AUTH" }];
  const model = inventoryModel({ snapshots: readings.snapshots, detections, connections, flags: readings.flags }, now);
  // Cursor is switched off; every other tool in play has one row, measured ones first.
  assert.deepEqual(model.map((tool) => [tool.name, tool.windows.length ? "bars" : tool.action?.label ?? tool.note]), [
    ["Codex", "bars"], ["Claude Code", "bars"], ["OpenRouter", "bars"],
    ["Antigravity", "Set up status line"],
    ["Gemini CLI", "Not measurable yet"], ["Grok (xAI)", "Sign in again"], ["Kimi", "Check again"], ["OpenCode", "Connect"],
  ]);
  // A tool a person chose stays in play, even with nothing detected yet.
  assert.ok(inventoryModel({ configured: ["CURSOR"] }, now).some((tool) => tool.code === "CURSOR"));
  assert.equal(inventoryModel({ configured: ["CURSOR"], removed: ["CURSOR"] }, now).some((tool) => tool.code === "CURSOR"), false);
  assert.deepEqual(inventoryModel({ detections: { providers: [{ provider_id: "kimi", state: "present" }] } }, now)
    .map((tool) => tool.code), ["CLAUDE", "ANTIGRAVITY", "OPENROUTER", "KIMI"]);
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderLimits(doc, mount, model, { handlers: {} });
  assert.deepEqual(leaks(spoken(mount)), []);
});

test("rows already on screen are held to the one freshness policy when a read fails", () => {
  const rows = fixtures.projected.snapshots;
  assert.equal(holdReadings(rows, now).length, rows.length);
  // Seven minutes on, the desktop Codex row expired; the status line Claude rows have not.
  const later = new Date(NOW + 7 * 60_000).toISOString();
  assert.deepEqual([...new Set(holdReadings(rows, later).map((row) => row.provider))], ["CLAUDE", "OPENROUTER"]);
  assert.deepEqual(holdReadings(rows, new Date(NOW + 30 * 60_000).toISOString()), []);
});

test("Home's model: tightest provider first, with Claude in its own meter order", () => {
  const model = limitsModel(projectReadings(JSON.stringify(fixtures.projected), null, now).snapshots, now);
  assert.deepEqual(model.map((provider) => provider.name), ["Codex", "Claude Code", "OpenRouter"]);
  assert.deepEqual(model[1].windows.map((window) => [window.label, window.value, window.band]),
    [["Current session", "6%", "green"], ["Weekly, all models", "46%", "green"], ["Weekly, Fable", "31%", "green"]]);
  const current = fixtures.projected.snapshots.find((row) => row.provider === "CLAUDE" && row.meter === "FIVE_HOUR");
  const weekly = fixtures.projected.snapshots.find((row) => row.provider === "CLAUDE" && row.meter === "SEVEN_DAY");
  assert.ok(current && weekly);
  const parserOutput = parseClaudePayload({
    extra_usage: { used_amount: 12.47, limit_amount: 20, currency: "USD" },
  }, now) ?? [];
  const parsedExtra = normalizeMetersReport(parserOutput.map((row) => ({
    ...row,
    accountId: weekly.accountId,
  })));
  assert.equal(parsedExtra.rejected.length, 0);
  const extraUsage = projectSnapshots(parsedExtra.snapshots, now).snapshots
    .find((row) => row.meter === "EXTRA_USAGE");
  assert.ok(extraUsage);
  const expandedClaude = limitsModel([
    extraUsage,
    { ...weekly, meter: "SEVEN_DAY_SONNET", value: 12.4 },
    { ...weekly, meter: "SEVEN_DAY_FABLE_5_1", value: 21.5 },
    { ...weekly, meter: "SEVEN_DAY_OPUS", value: 61 },
    weekly,
    current,
  ], now)[0];
  assert.deepEqual(expandedClaude.windows.map((window) => window.label), [
    "Current session",
    "Weekly, all models",
    "Weekly, Fable",
    "Weekly, Opus",
    "Weekly, Sonnet",
    "Extra usage",
  ]);
  assert.deepEqual([model[0].windows[0].label, model[0].windows[0].band, model[0].windows[0].reset], ["Weekly", "yellow", "4d 0h"]);
  assert.deepEqual([model[2].windows[0].value, model[2].windows[0].limit], ["$37.50", "$50.00 purchased, $12.50 used"]);
  // The raw cache still gives one card per provider; a second account says so by position.
  const raw = limitsModel(projectReadings(JSON.stringify(fixtures.raw), null, now).snapshots, now);
  assert.deepEqual(raw.map((provider) => provider.code), ["CODEX", "CLAUDE", "OPENROUTER"]);
  assert.ok(raw[1].windows.some((window) => window.label === "Weekly, all models, account\u00a02"));
  // Rows that went stale since the projection are not drawn.
  const later = new Date(NOW + 3_600_000).toISOString();
  assert.equal(limitsModel(fixtures.projected.snapshots, later).length, 0);
});

test("desktop values state their meaning once for balances and Kimi percentages", () => {
  const base = fixtures.projected.snapshots[0];
  const snapshots = [{
    ...base,
    provider: "OPENROUTER",
    meter: "ACCOUNT_BALANCE",
    value: 38.3,
    usedAmount: 7.66,
    limitAmount: 20,
    currency: "USD",
    window: { kind: "lifetime" },
    resetAt: null,
  }, {
    ...base,
    provider: "KIMI",
    meter: "FIVE_HOUR",
    value: 20,
  }];
  const model = limitsModel(snapshots, now);
  assert.equal(model.find((entry) => entry.code === "OPENROUTER").windows[0].value, "$12.34");
  assert.equal(model.find((entry) => entry.code === "KIMI").windows[0].value, "20%");
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderLimits(doc, mount, model, { compact: false });
  assert.doesNotMatch(mount.textContent, /\$12\.34 used|used used/u);
  assert.match(spoken(mount).join(" "), /20% used/u);
});

test("repeated Kimi windows preserve their duration and ordinal", () => {
  assert.equal(meterLabel("FIVE_HOUR_2", "KIMI"), "5 hour limit 2");
  assert.equal(meterLabel("FIVE_MINUTE", "KIMI"), "5 minute limit");
  assert.equal(meterLabel("DAILY", "KIMI"), "Daily limit");
});

/* A Claude status line row as the native projection hands it over while
   Claude Code idles: its policy expiry passed, its window has not reset. */
function idleClaude(ageMinutes, resetMinutes) {
  const observed = NOW - ageMinutes * 60_000;
  return {
    provider: "CLAUDE", meter: "FIVE_HOUR", value: 37, unit: "PERCENT", kind: "quota_percent",
    window: { kind: "rolling", durationSeconds: 18_000 }, resetAt: new Date(NOW + resetMinutes * 60_000).toISOString(),
    source: "native_payload", precision: "exact", observedAt: new Date(observed).toISOString(),
    expiresAt: new Date(observed + 132_000).toISOString(), accountId: ACCOUNTS.claude,
    provenance: { sourceKind: "statusline_payload", observedVia: "claude_code_statusline" },
    labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "native-statusline-payload", automationRisk: "low", verification: "UNVERIFIED" },
  };
}

test("an idle Claude Code card keeps its last reading, flat grey with its age, until that window resets", () => {
  const readings = projectReadings(JSON.stringify({ version: 2, snapshots: [idleClaude(45, 75)], flags: [] }), null, now);
  const model = limitsModel(readings.snapshots, now);
  assert.deepEqual(model.map((provider) => [provider.code, provider.age]), [["CLAUDE", "Updated 45 min ago"]]);
  assert.deepEqual(model[0].windows.map((window) => [window.value, window.band]), [["37%", "stale"]]);
  for (const compact of [false, true]) {
    const doc = fakeDocument();
    const mount = doc.createElement("div");
    renderLimits(doc, mount, model, { compact });
    assert.ok(spoken(mount).includes("Updated 45 min ago"));
    assert.equal(mount.all((node) => node.className === "q-row")[0].dataset.band, "stale");
    assert.deepEqual(leaks(spoken(mount)), []);
  }
  // A fresh card says nothing about its age, and after the reset nothing is drawn: no invented zero.
  assert.equal(limitsModel(fixtures.projected.snapshots, now).every((provider) => provider.age === null), true);
  assert.deepEqual(limitsModel(readings.snapshots, new Date(NOW + 76 * 60_000).toISOString()), []);
});

test("Claude asks to sign in again for a reading it cannot attribute, and waits for Claude Code after a reset", () => {
  const unresolved = { provider: "CLAUDE", reason: "account_unresolved", fixKind: "sign_in" };
  const waiting = { provider: "CLAUDE", reason: "awaiting_statusline", fixKind: "open_app" };
  assert.deepEqual(fixWords(unresolved, "rescan"), { issue: "fixSignInAgainIssue", detail: "fixToolDetail", action: "fixOpenAppAction" });
  assert.deepEqual(fixWords(unresolved, "connect"), { issue: "fixSignInAgainIssue", detail: "fixToolDetail", action: "fixSignInAction" });
  assert.deepEqual(fixWords(waiting, "rescan"), { issue: "fixWaitingIssue", detail: "fixWaitingDetail", action: "fixOpenAppAction" });
  for (const [flag, words] of [[unresolved, /^Claude CodeCheck again/u], [waiting, /^Claude CodeWaiting for Claude Code/u]]) {
    const doc = fakeDocument();
    const mount = doc.createElement("div");
    const flags = projectReadings(JSON.stringify({ version: 2, snapshots: [], flags: [flag] }), null, now).flags;
    renderLimits(doc, mount, inventoryModel({ flags }, now).filter((tool) => tool.code === "CLAUDE"), { handlers: {} });
    assert.match(mount.textContent, words);
    assert.deepEqual(leaks(spoken(mount)), []);
  }
});

test("bands follow 60, 80 and 90, and time left reads compactly", () => {
  const band = (value) => limitsModel([{ ...fixtures.projected.snapshots[3], value }], now)[0].windows[0].band;
  for (const [value, expected] of [[0, "green"], [59, "green"], [60, "yellow"], [79, "yellow"], [80, "orange"], [89, "orange"], [90, "red"], [100, "red"]]) {
    assert.equal(band(value), expected, String(value));
  }
  assert.equal(timeLeft("2026-09-29T13:55:00.000Z", now), "1h 55m");
  assert.equal(timeLeft("2026-10-03T12:00:00.000Z", now), "4d 0h");
  assert.equal(timeLeft("2026-09-29T12:00:20.000Z", now), "1m");
  assert.equal(timeLeft("2026-09-29T11:00:00.000Z", now), "");
  assert.equal(timeLeft(null, now), null);
  assert.equal(updatedLabel("2026-09-29T11:59:30.000Z", now), "Updated just now");
  assert.equal(updatedLabel("2026-09-29T11:48:00.000Z", now), "Updated 12 min ago");
  assert.equal(updatedLabel(null, now), "No reading yet");
});

test("drawn limits show names and words only, with a shape past green", () => {
  for (const compact of [false, true]) {
    const doc = fakeDocument();
    const mount = doc.createElement("div");
    renderLimits(doc, mount, limitsModel(projectReadings(JSON.stringify(fixtures.raw), null, now).snapshots, now), { compact });
    const cards = mount.all((node) => "providerCard" in node.dataset);
    assert.deepEqual(cards.map((card) => card.dataset.provider), ["CODEX", "CLAUDE", "OPENROUTER"]);
    assert.deepEqual(leaks(spoken(mount)), []);
    const rows = mount.all((node) => node.className === "q-row");
    for (const row of rows) {
      const shape = row.all((node) => node.className === "q-shape").length;
      assert.equal(shape, ["green", "none"].includes(row.dataset.band) ? 0 : 1, row.dataset.band);
      const role = row.dataset.band === "none" ? "status" : "progressbar";
      assert.ok(row.all((node) => node.getAttribute("role") === role).length === 1);
    }
    assert.equal(mount.all((node) => node.className === "q-colhead").length, compact ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(spoken(mount)), new RegExp(Object.values(ACCOUNTS).join("|")));
  }
});

test("a fix reads by its route: this window's own flow, or sign in in the tool and check again", () => {
  const signIn = { provider: "GROK", fixKind: "sign_in" };
  assert.deepEqual(fixWords(signIn, "connect"), { issue: "fixSignInIssue", detail: "fixSignInDetail", action: "fixSignInAction" });
  assert.deepEqual(fixWords(signIn, "rescan"), { issue: "fixSignInIssue", detail: "fixToolDetail", action: "fixOpenAppAction" });
  assert.deepEqual(fixWords({ provider: "OPENCODE", fixKind: "reconnect" }, "connect").action, "fixReconnectAction");
  assert.equal(fixWords({ provider: "KIMI", fixKind: "open_app" }, "rescan").action, "fixOpenAppAction");
  assert.equal(fixWords({ provider: "GEMINI_CLI", fixKind: "unsupported" }, "none").action, null);
});

test("every unmeasured row carries one note or one step with its sentence as a tooltip, none when unsupported", async () => {
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  const pressed = [];
  const model = inventoryModel({ snapshots: fixtures.projected.snapshots, flags: fixtures.projected.flags }, now);
  renderLimits(doc, mount, model, { handlers: { check: async (code) => { pressed.push(code); return code !== "KIMI"; }, connect: async () => true } });
  const rows = mount.all((node) => "providerCard" in node.dataset && !node.all((child) => child.className === "q-row").length);
  assert.equal(rows.length, 5);
  assert.deepEqual(leaks(spoken(mount)), []);
  for (const row of rows) {
    const steps = row.all((node) => "action" in node.dataset).length;
    const notes = row.all((node) => node.className === "q-tnote").length;
    assert.equal(steps + notes, 1, row.dataset.provider);
    assert.equal(notes, row.dataset.provider === "GEMINI_CLI" ? 1 : 0, row.dataset.provider);
  }
  const step = (provider) => rows.find((row) => row.dataset.provider === provider).all((node) => "action" in node.dataset)[0];
  assert.equal(step("GROK").getAttribute("title"), "Sign in to Grok (xAI) on this computer, then check again.");
  assert.equal(step("KIMI").getAttribute("title"), "Open Kimi once so it refreshes its own sign in, then check again.");
  await step("KIMI").fire("click");
  assert.deepEqual(pressed, ["KIMI"]);
  const kimi = rows.find((row) => row.dataset.provider === "KIMI");
  assert.equal(kimi.all((node) => node.className === "q-fstatus")[0].textContent, say("fixFailed"));
});

test("official marks are painted for any slot and never share a gradient id", () => {
  assert.match(officialMark("CLAUDE"), /^<svg focusable="false" fill="currentColor"/u);
  assert.match(officialMark("manual"), /stroke="currentColor"/u);
  const first = officialMark("ANTIGRAVITY").match(/id="([^"]+)"/u)[1];
  const second = officialMark("ANTIGRAVITY").match(/id="([^"]+)"/u)[1];
  assert.notEqual(first, second);
  assert.match(officialMark("ANTIGRAVITY"), /url\(#ol-antigravity-gradient-\d+\)/u);
});

test("the catalog has no dashes and ships translated in every locale", () => {
  for (const [key, value] of Object.entries(READINGS_COPY)) {
    if (key === "runtimeInstall") continue;
    assert.doesNotMatch(value, /[-‐-―−]/u, key);
  }
  const en = JSON.parse(read("../../web/messages/en.json"));
  const hubKeys = [
    "accountFallback", "updatedMinutes", "updatedHours", "updatedDays",
    "claudeCurrentSession", "claudeWeeklyAllModels", "claudeWeeklyFable",
    "claudeWeeklyModel", "claudeExtraUsage", "claudeFableDesktopHint",
    "codexMonthlyCreditLimit", "codexCredits", "openrouterKeyAllowance",
    "openrouterAccountBalance", "kimiWeeklyUsed", "kimiFiveHourUsed",
    "kimiFiveMinuteUsed", "kimiDailyUsed", "kimiSevenDayUsed", "kimiUsageUsed",
    "opencodeFiveHourPage", "opencodeWeeklyPage",
    "opencodeMonthlyPage", "noKeyCap", "keyNoSpendingCap",
    "unavailableScope", "unlimitedCredits",
    "creditBalanceLimitNotReported", "accountBalanceDetail",
    "creditsBalance", "balance", "percentUsed",
  ];
  const readings = (catalog) => ({
    ...catalog.desktopReadings,
    ...Object.fromEntries(hubKeys.map((key) => [key, catalog.hub[key]])),
  });
  assert.deepEqual(readings(en), READINGS_COPY);
  for (const locale of ["de", "es", "ja", "pt-BR"]) {
    const catalog = readings(JSON.parse(read(`../../web/messages/${locale}.json`)));
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(READINGS_COPY).sort(), locale);
    for (const [key, value] of Object.entries(catalog)) {
      if (key === "runtimeInstall") continue;
      assert.doesNotMatch(value, /[-‐-―−]/u, `${locale} ${key}`);
      assert.deepEqual(value.match(/\{\w+\}/gu) ?? [], READINGS_COPY[key].match(/\{\w+\}/gu) ?? [], `${locale} ${key}`);
    }
  }
});

/* ------------------------------------------------ the one screen's list */

const rowsOf = (mount) => mount.all((node) => "providerCard" in node.dataset);
const buttonIn = (row) => row.all((node) => node.localName === "button" && "action" in node.dataset)[0] ?? null;
const noteIn = (row) => row.all((node) => node.className === "q-tnote")[0] ?? null;

test("the list always has Claude Code, Antigravity and OpenRouter, each with one action when nothing is measured", () => {
  const model = inventoryModel({}, now);
  assert.deepEqual(model.map((tool) => tool.code), ["CLAUDE", "ANTIGRAVITY", "OPENROUTER"]);
  assert.deepEqual(model.map((tool) => [tool.action?.kind, tool.action?.label]), [
    ["connect", "Connect"], ["connect", "Set up status line"], ["connect", "Connect"],
  ]);
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderLimits(doc, mount, model, { handlers: { connect: async () => true, check: async () => true } });
  const rows = rowsOf(mount);
  assert.deepEqual(rows.map((row) => row.dataset.provider), ["CLAUDE", "ANTIGRAVITY", "OPENROUTER"]);
  for (const row of rows) {
    assert.equal(row.all((node) => node.localName === "button" && "action" in node.dataset).length, 1, row.dataset.provider);
    assert.equal(row.all((node) => node.className === "q-row").length, 0, "no bar without a reading");
  }
  assert.deepEqual(leaks(spoken(mount)), []);
});

test("each action button calls its own handler with its tool, and says so when it did not work", async () => {
  const calls = [];
  const handlers = {
    connect: async (code) => { calls.push(["connect", code]); return true; },
    check: async (code) => { calls.push(["check", code]); return true; },
  };
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderLimits(doc, mount, inventoryModel({}, now), { handlers });
  for (const row of rowsOf(mount)) await buttonIn(row).fire("click");
  assert.deepEqual(calls, [["connect", "CLAUDE"], ["connect", "ANTIGRAVITY"], ["connect", "OPENROUTER"]]);
});

test("configured Antigravity is idle and tells the user how to refresh quota", () => {
  const tool = inventoryModel({ detections: { providers: [{
    provider_id: "antigravity",
    state: "present",
    accounts: [],
    statusline_configured: true,
    statusline_state: "configured",
  }] } }, now).find((entry) => entry.code === "ANTIGRAVITY");
  assert.equal(tool.action, null);
  assert.equal(tool.note, "Status line set up. Use /usage in Antigravity CLI to refresh quota.");
});

test("Antigravity legacy and disabled status lines offer distinct recovery", () => {
  const tool = (statusline_state) => inventoryModel({ detections: { providers: [{
    provider_id: "antigravity", state: "installed_logged_out", accounts: [],
    statusline_configured: false, statusline_state,
  }] } }, now).find((entry) => entry.code === "ANTIGRAVITY");
  assert.deepEqual(
    [tool("legacy").action?.kind, tool("legacy").note],
    ["connect", "This older status line needs to be installed again."]
  );
  assert.deepEqual(
    [tool("disabled").action?.kind, tool("disabled").note],
    ["check", "Status line is off in Antigravity settings. Turn it on there, then use /usage to refresh quota."]
  );
});

test("Claude waits for Claude Code with no button, asks to sign in again, and connects when not set up", () => {
  const waiting = inventoryModel({ flags: [{ provider: "CLAUDE", reason: "awaiting_statusline", fixKind: "open_app" }] }, now)[0];
  assert.deepEqual([waiting.code, waiting.action, waiting.note], ["CLAUDE", null, "Waiting for Claude Code"]);
  const wired = inventoryModel({ claude: "READY_TO_ENABLE" }, now)[0];
  assert.deepEqual([wired.action, wired.note], [null, "Waiting for Claude Code"]);
  const unresolved = inventoryModel({ flags: [{ provider: "CLAUDE", reason: "account_unresolved", fixKind: "sign_in" }] }, now)[0];
  assert.deepEqual(unresolved.action, { kind: "check", label: "Check again", title: say("fixToolDetail", { name: "Claude Code" }) });
  assert.equal(inventoryModel({ claude: "DETECTED" }, now)[0].action.label, "Connect");
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderLimits(doc, mount, [waiting], { handlers: {} });
  const row = rowsOf(mount)[0];
  assert.equal(buttonIn(row), null);
  assert.equal(noteIn(row).textContent, "Waiting for Claude Code");
});

test("every Claude card with the direct check off offers the one click Fable action", async () => {
  const waitingFlag = [{ provider: "CLAUDE", reason: "awaiting_statusline", fixKind: "open_app" }];
  const title = READINGS_COPY.showClaudeFableNote;
  for (const input of [{ flags: waitingFlag }, { claude: "READY_TO_ENABLE" }, { claude: "CONNECTED" }]) {
    const off = inventoryModel({ ...input, claudePoll: false }, now)[0];
    assert.deepEqual([off.note, off.action], [null, null]);
    const on = inventoryModel({ ...input, claudePoll: true }, now)[0];
    assert.deepEqual([on.action, on.note], [null, "Waiting for Claude Code"]);
  }
  const measured = inventoryModel({ snapshots: fixtures.projected.snapshots, claudePoll: false }, now)
    .find((tool) => tool.code === "CLAUDE");
  assert.deepEqual([measured.note, measured.action], [null, null]);
  const measuredWithoutModelWindow = inventoryModel({
    snapshots: fixtures.projected.snapshots.filter((snapshot) =>
      snapshot.provider !== "CLAUDE" || !snapshot.meter.startsWith("SEVEN_DAY_")
    ),
    claudePoll: true,
  }, now).find((tool) => tool.code === "CLAUDE");
  assert.deepEqual([measuredWithoutModelWindow.note, measuredWithoutModelWindow.action], [null, null]);
  const app = read("./app.js");
  assert.match(app, /if \(tool\.code === "CLAUDE"\)[\s\S]*?showClaudeFable/u);
  assert.match(app, /id = "claude-poll"[\s\S]*?role = "switch"/u);
});

test("Codex with a reading and a waiting Claude: bars first, then the rows that need a step", () => {
  const codex = fixtures.projected.snapshots.filter((row) => row.provider === "CODEX");
  const model = inventoryModel({
    snapshots: codex,
    flags: [{ provider: "CLAUDE", reason: "awaiting_statusline", fixKind: "open_app" }],
    detections: { providers: [{ provider_id: "codex", state: "present" }, { provider_id: "claude", state: "present" }], antigravity_running: false },
  }, now);
  assert.deepEqual(model.map((tool) => [tool.code, tool.windows.length, tool.action?.label ?? tool.note]),
    [["CODEX", 1, null], ["CLAUDE", 0, "Waiting for Claude Code"], ["ANTIGRAVITY", 0, "Set up status line"], ["OPENROUTER", 0, "Connect"]]);
});

test("every tool in play gets one row with one fix; a switched off one leaves unless it always has a row", () => {
  const readings = projectReadings(JSON.stringify(fixtures.projected), null, now);
  const model = inventoryModel({ snapshots: readings.snapshots, flags: readings.flags }, now);
  const view = Object.fromEntries(model.map((tool) => [tool.code, tool.windows.length ? "bars" : tool.action?.label ?? tool.note]));
  assert.deepEqual(view, {
    CODEX: "bars", CLAUDE: "bars", OPENROUTER: "bars", ANTIGRAVITY: "Set up status line",
    GEMINI_CLI: "Not measurable yet", GROK: "Sign in again", KIMI: "Check again", OPENCODE: "Connect",
  });
  assert.equal(model.some((tool) => tool.code === "CURSOR"), false, "switched off");
  // An old account's flag waits behind the row's menu, never as a second row.
  assert.deepEqual(model.find((tool) => tool.code === "CLAUDE").extra.map((flag) => flag.reason), ["account_not_connected", "account_not_connected"]);
  const off = inventoryModel({ removed: ["ANTIGRAVITY"] }, now).find((tool) => tool.code === "ANTIGRAVITY");
  assert.deepEqual([off.action, off.note], [null, "Off"]);
  const connected = inventoryModel({ connections: [{ provider: "OPENROUTER", state: "CONNECTED" }] }, now).find((tool) => tool.code === "OPENROUTER");
  assert.equal(connected.action.label, "Check again");
  const lost = inventoryModel({ connections: [{ provider: "OPENROUTER", state: "NEEDS_AUTH" }] }, now).find((tool) => tool.code === "OPENROUTER");
  assert.equal(lost.action.label, "Connect");
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderLimits(doc, mount, model, { handlers: {} });
  assert.deepEqual(leaks(spoken(mount)), []);
});

test("a row's small menu opens on demand and is filled by its owner", async () => {
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  const filled = [];
  renderLimits(doc, mount, inventoryModel({}, now), { handlers: {}, more: (tool, panel) => { filled.push(tool.code); panel.append(doc.createElement("label")); } });
  const claude = rowsOf(mount)[0];
  const toggle = claude.all((node) => node.className === "q-more")[0];
  const panel = claude.all((node) => node.className === "q-morepanel")[0];
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(panel.hidden, true);
  await toggle.fire("click");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(panel.hidden, false);
  assert.deepEqual(filled, ["CLAUDE"]);
  assert.match(toggle.getAttribute("aria-label"), /Claude Code/u);
});

test("a Codex CLI that is not installed is named first, before any connect or sign in step", () => {
  const detection = { provider_id: "codex", state: "present", accounts: [{ account_id: "codex-a", recovery: "install_cli" }] };
  for (const situation of [
    {},
    { connections: [{ provider: "CODEX", state: "NEEDS_AUTH" }] },
    { flags: [{ provider: "CODEX", reason: "account_not_connected", fixKind: "sign_in" }] },
  ]) {
    const codex = inventoryModel({ detections: { providers: [detection] }, ...situation }, now)
      .find((tool) => tool.code === "CODEX");
    assert.deepEqual([codex.action?.kind, codex.action?.label, codex.note],
      ["check", "Check again", "Codex CLI not found. Put it on PATH, then check again."], JSON.stringify(situation));
  }
});

test("a step that did not work shows the handler's own sentence, and false keeps the general one", async () => {
  const sentence = "Codex needs a current login. Run codex login.";
  const answers = { CLAUDE: sentence, ANTIGRAVITY: false, OPENROUTER: true };
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderLimits(doc, mount, inventoryModel({}, now), { handlers: { connect: async (code) => answers[code] } });
  for (const row of rowsOf(mount)) await buttonIn(row).fire("click");
  const status = (row) => row.all((node) => node.className === "q-fstatus")[0].textContent;
  assert.deepEqual(rowsOf(mount).map(status), [sentence, say("fixFailed"), ""]);
});

test("a minute later the key holds, and a patch rewrites age and countdown without touching rows or messages", () => {
  const window = { key: "SEVEN_DAY", label: "Weekly", usedPercent: 40, observedAt: now, band: "stale", value: "40%",
    limit: null, unbounded: false, neutral: false };
  const tool = (age, reset, band = "stale") => [{ code: "CODEX", name: "Codex", age, windows: [{ ...window, band, reset }],
    action: { kind: "check", label: "Check again", title: null }, note: null, extra: [] }];
  const earlier = tool("Updated 7 min ago", "4h 12m");
  const later = tool("Updated 8 min ago", "4h 11m");
  assert.equal(limitsKey(later), limitsKey(earlier), "age and countdown are not structure");
  assert.notEqual(limitsKey(tool("Updated 8 min ago", "4h 11m", "red")), limitsKey(earlier), "a band is");
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderLimits(doc, mount, earlier, { handlers: { check: async () => true } });
  const nodes = mount.all(() => true);
  const message = mount.all((node) => node.className === "q-fstatus")[0];
  message.textContent = say("fixFailed");
  patchLimits(mount, later);
  assert.ok(mount.all(() => true).every((node, index) => node === nodes[index]), "the same nodes");
  assert.equal(mount.all((node) => node.className === "q-age")[0].textContent, "Updated 8 min ago");
  assert.equal(mount.all((node) => node.className === "q-rst")[0].textContent, say("resetsInValue", { time: "4h 11m" }));
  assert.equal(message.textContent, say("fixFailed"), "the row's own message survives");
});
