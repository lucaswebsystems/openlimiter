import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { devicesMarkup, FEATURES, planMarkup, proEntitled, refreshEntitlement } from "./pro.js";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");

/* EntitlementFeature::code in src-tauri/src/pro.rs, the names a token carries. */
const CONTRACT = ["alerts", "api_spend_beta", "history", "multi_account", "routing", "theme_preset"];

/* The ProStatus shape pro_status and pro_refresh answer with. Rust empties
   features whenever the token is outside its signed window. */
const status = (state, plan_state, features = CONTRACT) => ({
  rails_enabled: true,
  state,
  plan_state,
  features,
  grace_until: 1_800_259_200,
  expires_at: 1_800_086_400,
  multi_account: features.includes("multi_account"),
  theme_preset: features.includes("theme_preset"),
  device_cap: 5,
});

test("past due is entitled inside the signed window and not outside it", () => {
  for (const state of ["active", "refresh_due", "grace"]) {
    assert.equal(proEntitled(status(state, "past_due")), true, state);
  }
  for (const state of ["expired", "invalid", "clock_invalid"]) {
    assert.equal(proEntitled(status(state, "past_due", [])), false, state);
  }
  const inside = planMarkup(status("active", "past_due"), null);
  assert.match(inside, /Pro, payment failed/u);
  assert.match(inside, /id="pro-refresh-plan"/u);
  assert.doesNotMatch(inside, /id="pro-upgrade-monthly"/u);
  const outside = planMarkup(status("expired", "past_due", []), null);
  assert.match(outside, /id="pro-upgrade-monthly"/u);
  assert.doesNotMatch(outside, /payment failed|id="pro-refresh-plan"/u);
});

test("entitlement follows the validated status and features, never the plan name alone", () => {
  assert.equal(proEntitled(status("active", "trialing")), true);
  assert.equal(proEntitled(status("grace", "active")), true);
  assert.equal(proEntitled(status("expired", "active", [])), false);
  assert.equal(proEntitled(status("expired", "trialing", [])), false);
  assert.equal(proEntitled(status("active", "active", [])), false);
  assert.equal(proEntitled({ state: "unlicensed", plan_state: null, features: [] }), false);
  assert.equal(proEntitled(null), false);
  const ended = planMarkup(status("expired", "trialing", []), 0);
  assert.doesNotMatch(ended, /Pro trial/u);
  assert.match(ended, /data-state="free"/u);
});

test("the plan card lists the features a token really carries", () => {
  const keys = FEATURES.map((feature) => feature.key).sort();
  assert.deepEqual(keys, CONTRACT);
  const rust = read("../src-tauri/src/pro.rs");
  for (const key of keys) assert.match(rust, new RegExp(`=> "${key}",`, "u"));
  for (const feature of FEATURES) assert.doesNotMatch(feature.label, /[-\u2010-\u2015]/u);
  const card = planMarkup(status("active", "trialing", ["alerts", "history"]), 12);
  const on = [...card.matchAll(/<li data-on="true">.*?<span>(.*?)<\/span>/gu)].map((match) => match[1]);
  assert.deepEqual(on.sort(), FEATURES.filter((f) => ["alerts", "history"].includes(f.key)).map((f) => f.label).sort());
});

test("Refresh entitlement asks the service, then tells every gated control", async () => {
  const calls = [];
  const target = new EventTarget();
  let changed = 0;
  target.addEventListener("openlimiter:pro-changed", () => {
    changed += 1;
  });
  const result = await refreshEntitlement(
    {
      proRefresh: async () => {
        calls.push("pro_refresh");
        return { ok: true, value: status("active", "trialing") };
      },
      proStatus: async () => {
        calls.push("pro_status");
        return { ok: true, value: null };
      },
    },
    target,
  );
  assert.deepEqual(calls, ["pro_refresh"]);
  assert.equal(changed, 1);
  assert.equal(result.ok, true);
  assert.match(
    read("./pro.js"),
    /getElementById\("pro-refresh-plan"\)\?\.addEventListener\("click", async \(\) => \{\s*await refreshEntitlement\(\);\s*\}\);/u,
  );
});

test("the plan screen reads the trial end from the account plan read", () => {
  assert.match(read("./pro.js"), /trialDaysRemaining\(accountResult\.value\?\.entitlement\?\.trial_ends_at\)/u);
});

test("the window only asks the Pro service for actions its dispatchers know", () => {
  const block = read("./backend.js").match(/const PRO_ACTIONS = new Set\(\[([\s\S]*?)\]\);/u)?.[1] ?? "";
  const actions = [...block.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]).sort();
  assert.deepEqual(actions, [
    "account_status",
    "device_status",
    "history",
    "hosted_context",
    "list_notification_preferences",
    "rename_device",
    "revoke_device",
    "revoke_other_devices",
    "save_notification_preference",
  ]);
});

test("device rows say when a device was last seen, never an unknown platform", () => {
  const markup = devicesMarkup(
    [
      { id: "a", name: "Desktop", current: true, last_seen_at: 1_790_769_600_500 },
      { id: "b", name: "Pixel", current: false, last_seen_at: null },
    ],
    5,
  );
  assert.match(markup, /Last seen /u);
  assert.match(markup, /Not seen yet/u);
  assert.doesNotMatch(markup, /unknown/u);
  assert.doesNotMatch(read("./pairing.js"), /device\.platform/u);
});

test("a comped plan reads as Pro", () => {
  assert.match(planMarkup(status("active", "comped"), null), /<span class="plan-name">Pro<\/span>/u);
  assert.match(read("./app.js"), /comped: "Pro"/u);
});

test("a stale grant shows Pro needing Reconnect, and a good refresh takes it away", async () => {
  const stale = planMarkup(status("expired", "active", []), null, true);
  assert.match(stale, /Pro needs to reconnect/u);
  assert.match(stale, /id="pro-reconnect"[^>]*>Reconnect</u);
  assert.doesNotMatch(stale, /Device limit/u);
  assert.doesNotMatch(planMarkup(status("active", "active"), null), /pro-reconnect/u);

  const target = new EventTarget();
  const refresh = (result) => refreshEntitlement({ proRefresh: async () => result }, target);
  await refresh({ ok: false, reason: "command_failed", kind: "stale_grant" });
  assert.match(read("./backend.js"), /stale_grant: "Pro needs to reconnect/u);
  await refresh({ ok: true, value: status("active", "active") });
});

test("Reconnect drops the local Pro trust and refreshes, revoking nothing", () => {
  const app = read("./app.js");
  assert.match(app, /closest\("#pro-reconnect"\)\) \{\s*void proDisconnect\(\)\.then\(\(\) => refreshEntitlement\(\)\);/u);
  assert.doesNotMatch(app, /pro-reconnect[\s\S]{0,300}(revoke|accountLogout)/u);
});
