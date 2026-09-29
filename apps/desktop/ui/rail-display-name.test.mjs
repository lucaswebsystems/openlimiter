import test from "node:test";
import assert from "node:assert/strict";
import { accountView } from "./rail.js";
import { PROVIDER_SPECS } from "./provider-specs.generated.js";

test("Rail labels use the registry display name with an unknown provider fallback", () => {
  const row = { provider: "claude", account: null, availability: "available", value: 42,
    kind: "quota_percent", meaning: "used", windowLabel: "Session", freshness: "fresh", band: "green" };
  const name = PROVIDER_SPECS.providers.find(spec => spec.directory?.connectorId === row.provider).displayName;
  assert.equal(accountView(row).label, `${name}: 42% used (Session)`);
  assert.equal(accountView({ ...row, account: "Work" }).label, `${name}, Work: 42% used (Session)`);
  assert.equal(accountView({ ...row, provider: "unknown" }).label, "unknown: 42% used (Session)");
});
