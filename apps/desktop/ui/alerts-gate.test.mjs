import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { trialDaysRemaining, trialSentence } from "./pro.js";
import { ALERTS_EN, quietSentence } from "./settings.js";
import { shouldNotifyLocally, shouldSendRemote, thresholdDedupeKey } from "../../../packages/core/dist/contracts/notify.js";

const read = (name) => readFileSync(new URL("./" + name, import.meta.url), "utf8");

test("the bell distinguishes free desktop alerts from Pro phone push and email", () => {
  const html = read("index.html");
  const gate = html.slice(
    html.indexOf('id="notification-gate"'),
    html.indexOf('id="notification-events"'),
  );
  assert.match(gate, /Desktop alerts stay free/u);
  assert.match(gate, /id="notification-upgrade"[^>]*>Upgrade to Pro</u);
  assert.match(gate, /with or without an account/u);
  assert.match(gate, /Phone push and email are Pro/u);
});

test("the local gate grants OS permission access without consulting a subscription", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /id="notification-gate" class="notification-gate" hidden/u);
  assert.match(app, /const result = await notificationGate\(\);/u);
  assert.match(app, /elements\.notificationGate\.hidden = entitled;/u);
  const rust = readFileSync(new URL("../src-tauri/src/notifications.rs", import.meta.url), "utf8");
  assert.match(rust, /pub fn notification_gate\(\) -> NotificationGate\s*\{\s*NotificationGate \{ entitled: true \}/u);
  assert.doesNotMatch(rust, /crate::pro::|KeyringStore/u);
});

test("the operating system is asked for alerts only where one could fire", () => {
  // The native gate is free; an unavailable backend still cannot raise a toast.
  const app = read("app.js");
  assert.match(app, /if \(!entitled \|\| permissionAsked\) return;/u);
  assert.match(app, /permissionAsked = true;\s*const outcome = await requestAlertPermission\(\)/u);
  /* And it is not asked during first run any more. */
  assert.equal(read("first-run.js").includes("showPermission"), false);
  assert.equal(read("index.html").includes("first-run-permission"), false);
});

test("Settings names local controls and catalogs the Free and Pro boundary", () => {
  const settings = read("settings.js");
  const html = read("index.html");
  for (const key of Object.keys(ALERTS_EN)) {
    if (["localFreeTitle", "signInLead"].includes(key)) {
      assert.ok(html.includes(`data-i18n="alerts.${key}">${ALERTS_EN[key]}<`), key);
    } else {
      assert.ok(settings.includes(`ALERTS_EN.${key}`), key);
    }
    assert.doesNotMatch(ALERTS_EN[key], /[-\u2010-\u2015]/u);
  }
  assert.match(ALERTS_EN.localFree, /with or without an account\. Phone push and email are Pro/u);
  assert.match(quietSentence({ quietStart: "22:00", quietEnd: "07:00", timeZone: "UTC" }), /^Desktop alerts are held/u);
  assert.equal(ALERTS_EN.channelOn, "Desktop alerts on");
  assert.equal(ALERTS_EN.channelOff, "Desktop alerts off");
  assert.match(read("app.js"), /title\.textContent = ALERTS_EN\.localFreeTitle/u);
});

const now = Date.parse("2026-09-01T10:00:00Z");
const channel = () => ({ enabled: true, quietHours: null, snoozedUntil: null, mutedProviders: [] });
const preferences = () => ({ local: channel(), remote: channel() });
const submission = {
  kind: "threshold",
  dedupeKey: thresholdDedupeKey("CODEX", null, "weekly", "cycle-one", "threshold", 80),
  provider: "CODEX", account: null, localChannel: "popup", remoteChannel: true,
};

test("a free account gets a local 80 percent popup and no remote push or email submission", () => {
  assert.equal(shouldNotifyLocally(submission, preferences(), now), true);
  assert.equal(shouldSendRemote(submission, preferences(), now, { remoteNotifications: false }), false);
});

test("Pro permits both the local popup and the remote push or email submission", () => {
  assert.equal(shouldNotifyLocally(submission, preferences(), now), true);
  assert.equal(shouldSendRemote(submission, preferences(), now, { remoteNotifications: true }), true);
});

test("trial expiry keeps local popups and preferences while stopping remote delivery", () => {
  const prefs = preferences();
  const before = structuredClone(prefs);
  const entitlement = { remoteNotifications: true };
  assert.equal(shouldSendRemote(submission, prefs, now, entitlement), true);
  entitlement.remoteNotifications = false;
  assert.equal(shouldNotifyLocally(submission, prefs, now), true);
  assert.equal(shouldSendRemote(submission, prefs, now, entitlement), false);
  assert.deepEqual(prefs, before);
});

test("quiet hours, snooze and provider mute apply to the two channels independently", () => {
  for (const restriction of [
    { mutedProviders: ["CODEX"] },
    { snoozedUntil: "2026-09-01T11:00:00Z" },
    { quietHours: { startMinute: 600, endMinute: 660, utcOffsetMinutes: 0 } },
  ]) {
    for (const target of ["local", "remote"]) {
      const prefs = preferences();
      Object.assign(prefs[target], restriction);
      assert.equal(shouldNotifyLocally(submission, prefs, now), target !== "local");
      assert.equal(shouldSendRemote(submission, prefs, now, { remoteNotifications: true }), target !== "remote");
    }
  }
});

test("the client never starts a trial and never assembles a price", () => {
  const pro = read("pro.js");
  assert.equal(pro.includes("start_trial"), false);
  assert.match(pro, /id="pro-upgrade-monthly"/u);
  assert.match(pro, /id="pro-upgrade-yearly"/u);
  assert.match(pro, /await proCheckoutUrl\(plan\)/u);
  assert.match(pro, /await proPortalUrl\("manage"\)/u);
});

test("a completed purchase shows up when the window comes back into focus", () => {
  const app = read("app.js");
  assert.match(app, /window\.addEventListener\("focus"/u);
  assert.match(app, /void proRefresh\(\)\.then\(\(\) => \{\s*void paintPlanBadge\(\);/u);
});

test("the trial says how many days are left, from the service instant", () => {
  const day = 86_400_000;
  const now = Date.parse("2026-09-04T12:00:00Z");
  assert.equal(trialDaysRemaining("2026-10-04T12:00:00Z", now), 30);
  assert.equal(trialDaysRemaining(new Date(now + day).toISOString(), now), 1);
  assert.equal(trialDaysRemaining(new Date(now - day).toISOString(), now), 0);
  assert.equal(trialDaysRemaining(null, now), null);
  assert.equal(trialDaysRemaining("not a date", now), null);

  assert.equal(trialSentence(30), "Pro trial, 30 days left");
  assert.equal(trialSentence(1), "Pro trial, 1 day left");
  assert.equal(trialSentence(0), "Pro trial, ending today");
  assert.equal(trialSentence(null), "Pro trial running");
});

test("the plan cap refusal names what Pro adds instead of what Free forbids", () => {
  const backend = read("backend.js");
  assert.match(backend, /plan_cap: "Pro unlocks more accounts\./u);
  assert.equal(backend.includes("Free allows one active account"), false);
});

test("no copy added to the alert and billing surfaces carries a dash", () => {
  const dashes = /[-‐-―]/u;
  for (const sentence of [
    trialSentence(30),
    trialSentence(1),
    trialSentence(0),
    trialSentence(null),
  ]) {
    assert.equal(dashes.test(sentence), false, sentence);
  }
  const gate = read("index.html");
  const block = gate.slice(
    gate.indexOf('<strong id="notification-gate-title"'),
    gate.indexOf('id="notification-upgrade"'),
  );
  assert.equal(dashes.test(block.replaceAll(/<[^>]*>/gu, "")), false, block);
});
