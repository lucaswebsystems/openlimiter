import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { FEATURES, planMarkup, proEntitled, refreshEntitlement } from "./pro.js";

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
