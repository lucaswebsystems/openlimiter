import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { trialDaysRemaining, trialSentence } from "./pro.js";

const read = (name) => readFileSync(new URL("./" + name, import.meta.url), "utf8");

test("the bell says alerts are a Pro feature and offers the way out of it", () => {
  const html = read("index.html");
  const gate = html.slice(
    html.indexOf('id="notification-gate"'),
    html.indexOf('id="notification-events"'),
  );
  assert.match(gate, /Alerts are a Pro feature/u);
  assert.match(gate, /id="notification-upgrade"[^>]*>Upgrade to Pro</u);
  /* And it says what is NOT behind the plan, because a paywall with no stated
     boundary reads as a paywall over everything. */
  assert.match(gate, /Every meter and every reading in this window is free/u);
});

test("the gate ships hidden and is revealed only by a read entitlement", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.match(html, /id="notification-gate" class="notification-gate" hidden/u);
  assert.match(app, /const result = await notificationGate\(\);/u);
  assert.match(app, /elements\.notificationGate\.hidden = entitled;/u);
});

test("the operating system is asked for alerts only where one could fire", () => {
  /* Every notification is Pro. Asking a Free machine for permission to raise
     a toast it will never raise is asking for something for nothing. */
  const app = read("app.js");
  assert.match(app, /if \(!entitled \|\| permissionAsked\) return;/u);
  assert.match(app, /permissionAsked = true;\s*const outcome = await requestAlertPermission\(\)/u);
  /* And it is not asked during first run any more. */
  assert.equal(read("first-run.js").includes("showPermission"), false);
  assert.equal(read("index.html").includes("first-run-permission"), false);
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
    gate.indexOf('<strong id="notification-gate-title">'),
    gate.indexOf('id="notification-upgrade"'),
  );
  assert.equal(dashes.test(block.replaceAll(/<[^>]*>/gu, "")), false, block);
});
