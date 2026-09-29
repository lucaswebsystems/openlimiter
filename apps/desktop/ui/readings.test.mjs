import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeMetersReport, projectSnapshots } from "../../../packages/core/dist/index.js";
import { messyFixtures, ACCOUNTS } from "./messy-fixtures.mjs";
import { agentName, meterLabel, providerCode, providerName, READINGS_COPY, say } from "./names.js";
import { fakeDocument, leaks, spoken } from "./test-dom.mjs";
// readings.js reaches the compiled engine, which only exists in the build.
import {
  attentionFlags, connectedProviders, fixWords, holdReadings, limitsModel, officialMark, projectReadings, renderAttention,
  renderConnected, renderLimits, timeLeft, updatedLabel,
} from "./dist/readings.js";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const now = new Date(NOW).toISOString();
const fixtures = messyFixtures(NOW);
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");

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
    ["FIVE_HOUR", "CLAUDE", "5 hour"], ["five_hour", "KIMI", "5 hour"], ["SEVEN_DAY", "CODEX", "Weekly"],
    ["SEVEN_DAY_FABLE", "CLAUDE", "Fable weekly"], ["SEVEN_DAY_OPUS", "CLAUDE", "Opus weekly"],
    ["SEVEN_DAY_HAIKU_4_5", "CLAUDE", "Haiku 4.5 weekly"], ["SEVEN_DAY_OAUTH_APPS", "CLAUDE", "OAuth Apps weekly"],
    ["FIVE_HOUR_2", "CLAUDE", "5 hour 2"], ["PRIMARY", "CODEX", "Primary window"], ["CREDITS", "OPENROUTER", "Credits"],
    ["GEMINI_3_1_PRO_PREVIEW", "GEMINI_CLI", "Gemini 3.1 Pro Preview"], ["BRAND_NEW_WINDOW", "CLAUDE", "Brand new window"],
    ["MONTHLY", "SOMEONE", "Monthly"],
  ];
  for (const [code, provider, label] of cases) assert.equal(meterLabel(code, provider), label, code);
  assert.deepEqual(leaks(cases.map(([code, provider]) => meterLabel(code, provider))), []);
  assert.equal(agentName("claude_code"), "Claude Code");
  assert.equal(agentName("unknown"), null);
});

test("a reserved or id shaped meter code reads as the neutral Limit, never as itself", () => {
  for (const code of ["UNKNOWN", "UNKNOWN_WINDOW", "NULL", "A1B2C3D4E5F60718", "PLAN_4B1D4B1D0123", "X_ABCDEFGHIJKLMNOPQRS"]) {
    assert.equal(meterLabel(code, "MANUAL"), "Limit", code);
  }
  // Ordinary codes with numbers in them still read as words.
  assert.equal(meterLabel("TEAM_PLAN", "MANUAL"), "Team plan");
  assert.equal(meterLabel("SEVEN_DAY_HAIKU_4_5", "CLAUDE"), "Haiku 4.5 weekly");
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

test("Needs attention holds one row per unmeasurable provider, never one Home shows or one switched off", () => {
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

test("Connected lists what is switched on and measured, detected or keyed, never a flagged or switched off one", () => {
  const readings = projectReadings(JSON.stringify(fixtures.projected), null, now);
  const attention = attentionFlags(readings.flags, readings.snapshots);
  const detections = { providers: [
    { provider_id: "gemini-cli", state: "present" }, { provider_id: "cursor", state: "present" },
    { provider_id: "grok", state: "installed_logged_out" },
  ] };
  const connections = [{ provider: "opencode", state: "CONNECTED" }, { provider: "antigravity", state: "NEEDS_AUTH" }];
  const connected = connectedProviders({ snapshots: readings.snapshots, detections, connections, flags: readings.flags, attention });
  // Cursor is switched off, Gemini CLI and OpenCode wait in Needs attention.
  assert.deepEqual(connected.map((provider) => [provider.name, provider.access]),
    [["Claude Code", "automatic"], ["Codex", "automatic"], ["OpenRouter", "key"]]);
  assert.deepEqual(connectedProviders({ snapshots: [], detections: { providers: [{ provider_id: "kimi", state: "present" }] } })
    .map((provider) => provider.code), ["KIMI"]);
  assert.deepEqual(connectedProviders({ snapshots: [] }), []);
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  renderConnected(doc, mount, [...connected, { code: "MANUAL", name: "Manual", access: "manual" }]);
  const rows = mount.all((node) => "connectedRow" in node.dataset);
  assert.deepEqual(rows.map((row) => row.textContent), [
    "Claude CodeUses your Claude Code sign in on this computerConnected",
    "CodexUses your Codex sign in on this computerConnected",
    "OpenRouterUses your OpenRouter keyConnected",
    "ManualUses the numbers you enteredConnected",
  ]);
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

test("Home's model: one entry per provider, tightest window and tightest provider first", () => {
  const model = limitsModel(projectReadings(JSON.stringify(fixtures.projected), null, now).snapshots, now);
  assert.deepEqual(model.map((provider) => provider.name), ["Codex", "Claude Code", "OpenRouter"]);
  assert.deepEqual(model[1].windows.map((window) => [window.label, window.value, window.band]),
    [["Weekly", "46%", "green"], ["Fable weekly", "31%", "green"], ["5 hour", "6%", "green"]]);
  assert.deepEqual([model[0].windows[0].label, model[0].windows[0].band, model[0].windows[0].reset], ["Weekly", "yellow", "4d 0h"]);
  assert.deepEqual([model[2].windows[0].value, model[2].windows[0].limit], ["$12.50", "$50.00"]);
  // The raw cache still gives one card per provider; a second account says so by position.
  const raw = limitsModel(projectReadings(JSON.stringify(fixtures.raw), null, now).snapshots, now);
  assert.deepEqual(raw.map((provider) => provider.code), ["CODEX", "CLAUDE", "OPENROUTER"]);
  assert.ok(raw[1].windows.some((window) => window.label === "Weekly, account\u00a02"));
  // Rows that went stale since the projection are not drawn.
  const later = new Date(NOW + 3_600_000).toISOString();
  assert.equal(limitsModel(fixtures.projected.snapshots, later).length, 0);
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
      assert.equal(shape, row.dataset.band === "green" ? 0 : 1, row.dataset.band);
      assert.ok(row.all((node) => node.getAttribute("role") === "progressbar").length === 1);
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

test("Needs attention rows carry one sentence and one fix, or none when unsupported", async () => {
  const doc = fakeDocument();
  const mount = doc.createElement("div");
  const pressed = [];
  const flags = attentionFlags(fixtures.projected.flags, fixtures.projected.snapshots);
  const route = (flag) => flag.fixKind === "unsupported" ? "none" : flag.provider === "OPENCODE" ? "connect" : "rescan";
  renderAttention(doc, mount, flags, { route, fix: async (flag) => { pressed.push(flag.provider); return flag.provider !== "KIMI"; } });
  const rows = mount.all((node) => "flagRow" in node.dataset);
  assert.equal(rows.length, 5);
  assert.deepEqual(leaks(spoken(mount)), []);
  for (const row of rows) {
    const fixes = row.all((node) => "fix" in node.dataset);
    assert.equal(fixes.length, 1, row.dataset.provider);
    assert.equal(fixes[0].localName, row.dataset.fixKind === "unsupported" ? "p" : "button");
  }
  const grok = rows.find((row) => row.dataset.provider === "GROK");
  assert.match(grok.textContent, /Sign in to Grok \(xAI\) on this computer, then check again\.Check again/u);
  const kimi = rows.find((row) => row.dataset.provider === "KIMI");
  assert.match(kimi.textContent, /Open Kimi once so it refreshes its own sign in, then check again\./u);
  await kimi.all((node) => node.localName === "button")[0].fire("click");
  assert.deepEqual(pressed, ["KIMI"]);
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
  for (const [key, value] of Object.entries(READINGS_COPY)) assert.doesNotMatch(value, /[-‐-―−]/u, key);
  const en = JSON.parse(read("../../web/messages/en.json"));
  assert.deepEqual(en.desktopReadings, READINGS_COPY);
  for (const locale of ["de", "es", "ja", "pt-BR"]) {
    const catalog = JSON.parse(read(`../../web/messages/${locale}.json`)).desktopReadings;
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(READINGS_COPY).sort(), locale);
    for (const [key, value] of Object.entries(catalog)) {
      assert.doesNotMatch(value, /[-‐-―−]/u, `${locale} ${key}`);
      assert.deepEqual(value.match(/\{\w+\}/gu) ?? [], READINGS_COPY[key].match(/\{\w+\}/gu) ?? [], `${locale} ${key}`);
    }
  }
});
