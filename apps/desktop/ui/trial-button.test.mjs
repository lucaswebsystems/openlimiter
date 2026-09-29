import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDesktopTrial, desktopTrialMarkup, desktopTrialState, TRIAL_EN, TRIAL_URL } from "./settings.js";

const now = Date.parse("2026-09-28T12:00:00Z");
const account = { signedIn: true, email: "person@example.test" };
const status = (value) => ({ ok: true, value });
const running = { plan_state: "trialing", trial_ends_at: new Date(now + 30 * 86400000).toISOString() };

test("Home and Settings offer a trial only for a known signed in unused free account", () => {
  assert.deepEqual(desktopTrialState(account, status({ plan_state: "none" }), now), { kind: "offer" });
  for (const plan_state of ["active", "comped", "past_due", "expired", "canceled", "refunded", "unknown"]) {
    const state = desktopTrialState(account, status({ plan_state }), now);
    assert.equal(state.kind, "hidden");
    assert.equal(desktopTrialMarkup(state), "");
  }
  for (const row of [
    { plan_state: "free", trial_ends_at: new Date(now - 1).toISOString() },
    { plan_state: "free", trial_used: true },
    { plan_state: "none", trial_started_at: "2026-01-01" },
    { plan_state: "none", had_paid_entitlement: true },
    { ...running, trial_ends_at: new Date(now - 1).toISOString() },
  ]) assert.equal(desktopTrialState(account, status(row), now).kind, "hidden");
  assert.equal(desktopTrialState({ signedIn: false }, status({ plan_state: "none" }), now).kind, "hidden");
  assert.equal(desktopTrialState(account, { ok: false }, now).kind, "hidden");
  assert.equal(desktopTrialState(account, status(null), now).kind, "hidden");
});

test("the trial chip rounds partial days up, links to billing and disappears at expiry", () => {
  assert.deepEqual(desktopTrialState(account, status(running), now), { kind: "running", days: 30 });
  const lastDay = desktopTrialState(account, status(running), now + 29.5 * 86400000);
  assert.deepEqual(lastDay, { kind: "running", days: 1 });
  assert.match(desktopTrialMarkup(lastDay), /Pro trial, 1 day left/u);
  assert.match(desktopTrialMarkup(lastDay), /href="#pro-mount"/u);
  assert.doesNotMatch(desktopTrialMarkup(lastDay), /data-trial-start/u);
  assert.equal(desktopTrialState(account, status(running), now + 30 * 86400000).kind, "hidden");
});

test("one click opens the web trial flow without invoking the native start action", async () => {
 let starts = 0;
 const opened = [];
 const controller = createDesktopTrial({
  accountStatus: async () => status(account),
  proService: async (action) => {
  if (action === "account_status") return status({ plan_state: "none" });
  starts += 1;
  return status({});
  },
  },
  () => {},
  (url) => { opened.push(url); return {}; },
  );
 await controller.refresh();
 await controller.start();
 assert.deepEqual(opened, [TRIAL_URL]);
 assert.equal(starts, 0);
 const snapshot = controller.snapshot();
 assert.equal(snapshot.complete, false);
 assert.equal(snapshot.state.kind, "offer");
 assert.equal(snapshot.error, null);
});

test("a blocked browser leaves the offer available with a retry message", async () => {
 const controller = createDesktopTrial({
  accountStatus: async () => status(account),
  proService: async () => status({ plan_state: "none" }),
  },
  () => {},
  () => null,
  );
 await controller.refresh();
 await controller.start();
 const snapshot = controller.snapshot();
 assert.equal(snapshot.state.kind, "offer");
 assert.equal(snapshot.error, TRIAL_EN.unavailable);
});

test("trial mounts sit at the Home header and the Settings Pro description", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("./index.html"), /id="panel-meters"[^>]*>\s*<div class="desktop-trial" data-desktop-trial hidden>/u);
  assert.match(read("./settings.js"), /data-desktop-trial hidden[\s\S]*preset-grid/u);
  const css = read("./app.css");
  assert.match(css, /\.desktop-trial :is\(button, a\)[\s\S]*?min-height: 24px/u);
  assert.match(css, /\.desktop-trial :is\(button, a\):focus-visible[\s\S]*?outline: 2px solid var\(--ol-accent-solid\)/u);
  for (const value of Object.values(TRIAL_EN)) assert.doesNotMatch(value, /[-\u2010-\u2015]/u);
});
