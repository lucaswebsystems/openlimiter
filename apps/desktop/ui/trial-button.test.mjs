import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDesktopTrial, desktopTrialMarkup, desktopTrialState, TRIAL_EN, TRIAL_URL } from "./settings.js";

const now = Date.parse("2026-09-28T12:00:00Z");
const account = { signedIn: true, email: "person@example.test" };
const status = (value) => ({ ok: true, value });
/* What account_status answers with since 2.0.3: the `/entitlement` status
   read, whose entitlement is null for an account that never had a trial or a
   plan. */
const plan = (entitlement) => status({ entitlement, devices: [] });
const running = { plan_state: "trialing", trial_ends_at: new Date(now + 30 * 86400000).toISOString() };
const ended = new Date(now - 1).toISOString();

test("Home and Settings offer a trial only to a signed in account that never had one", () => {
  assert.deepEqual(desktopTrialState(account, plan(null), now), { kind: "offer" });
  for (const plan_state of ["active", "comped", "past_due", "expired", "canceled", "refunded", "deleted", "revoked", "unknown"]) {
    const state = desktopTrialState(account, plan({ plan_state, trial_ends_at: null }), now);
    assert.equal(state.kind, "hidden");
    assert.equal(desktopTrialMarkup(state), "");
  }
  /* A returning account whose trial ended: no offer and no chip. */
  for (const row of [
    { ...running, trial_ends_at: ended },
    { plan_state: "expired", trial_ends_at: ended },
    { plan_state: "canceled", trial_ends_at: ended },
  ]) assert.equal(desktopTrialState(account, plan(row), now).kind, "hidden");
  assert.equal(desktopTrialState({ signedIn: false }, plan(null), now).kind, "hidden");
  assert.equal(desktopTrialState(account, { ok: false }, now).kind, "hidden");
  assert.equal(desktopTrialState(account, status(null), now).kind, "hidden");
  assert.equal(desktopTrialState(account, status({ devices: [] }), now).kind, "hidden");
});

test("the trial chip rounds partial days up, links to billing and disappears at expiry", () => {
  assert.deepEqual(desktopTrialState(account, plan(running), now), { kind: "running", days: 30 });
  const lastDay = desktopTrialState(account, plan(running), now + 29.5 * 86400000);
  assert.deepEqual(lastDay, { kind: "running", days: 1 });
  assert.match(desktopTrialMarkup(lastDay), /Pro trial, 1 day left/u);
  assert.match(desktopTrialMarkup(lastDay), /href="#pro-plan"/u);
  assert.doesNotMatch(desktopTrialMarkup(lastDay), /data-trial-start/u);
  assert.equal(desktopTrialState(account, plan(running), now + 30 * 86400000).kind, "hidden");
});

test("a fresh account with no connected tools sees the trial, a returning one whose trial ended does not", async () => {
  const controller = (entitlement) => createDesktopTrial({
    accountStatus: async () => status(account),
    proService: async (action) => (action === "account_status" ? plan(entitlement) : status({})),
  }, () => {}, () => ({}));
  const fresh = controller(null);
  await fresh.refresh();
  assert.equal(fresh.snapshot().state.kind, "offer");
  const returning = controller({ ...running, trial_ends_at: ended });
  await returning.refresh();
  assert.equal(returning.snapshot().state.kind, "hidden");
});

test("one click opens the web trial flow without invoking the native start action", async () => {
 let starts = 0;
 const opened = [];
 const controller = createDesktopTrial({
  accountStatus: async () => status(account),
  proService: async (action) => {
  if (action === "account_status") return plan(null);
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
  proService: async () => plan(null),
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

test("the menu reaches the trial, the plan and billing, and nothing routes through a tab", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const html = read("./index.html");
  const settingsPanel = html.slice(html.indexOf('id="tab-panel-settings"'), html.indexOf('id="phone-popover"'));
  assert.match(settingsPanel, /<div class="desktop-trial" data-desktop-trial hidden><\/div>/u);
  assert.match(settingsPanel, /id="pro-mount"/u);
  assert.match(settingsPanel, /id="settings-appearance"/u);
  assert.match(html, /role="tab"|role="tabpanel"|id="tab-/u);
  /* The running trial's chip opens the menu at the plan, where billing is. */
  const settings = read("./settings.js");
  assert.match(desktopTrialMarkup({ kind: "running", days: 3 }), /data-trial-billing href="#pro-plan"/u);
  assert.match(settings, /data-trial-billing[\s\S]*?showPlan\(\)/u);
  assert.match(settings + read("./plan-cap.js"), /tab-settings/u);
  assert.match(settings, /export function showPlan\(/u);
  assert.match(read("./plan-cap.js"), /action === "unlock"\) \{\s*showPlan\(\);/u);
  const app = read("./app.js");
  /* Mounted when the window starts, not when a tab first opens. */
  assert.match(app, /renderPro\(elements\.proMount\)/u);
  assert.match(app, /renderSettings\(elements\.settingsMount\)/u);
  /* The plan card offers Checkout to Free and the billing portal to Pro. */
  const pro = read("./pro.js");
  assert.match(pro, /id="pro-upgrade-monthly"/u);
  assert.match(pro, /id="pro-portal">Manage billing</u);
  const css = read("./app.css");
  assert.match(css, /\.desktop-trial :is\(button, a\)[\s\S]*?min-height: 24px/u);
  assert.match(css, /\.desktop-trial :is\(button, a\):focus-visible[\s\S]*?outline: 2px solid var\(--ol-accent-solid\)/u);
  for (const value of Object.values(TRIAL_EN)) assert.doesNotMatch(value, /[-\u2010-\u2015]/u);
});
