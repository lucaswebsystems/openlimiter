import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PRO_PRICING = JSON.parse(
  await readFile(new URL("../lib/pro-pricing.json", import.meta.url), "utf8"),
);

assert.equal(PRO_PRICING.entitlementProduct, "openlimiter_pro");

assert.deepEqual(PRO_PRICING.monthly, {
  interval: "month",
  priceId: "price_1U6O7uJoit5X1fsg9no5Oza0",
  amountUsd: 5,
});
assert.deepEqual(PRO_PRICING.yearly, {
  interval: "year",
  priceId: "price_1U6O8sJoit5X1fsgf1IfJ6Sk",
  amountUsd: 50,
});
assert.notEqual(PRO_PRICING.monthly.priceId, PRO_PRICING.yearly.priceId);

console.log("Pro pricing contract is valid");
