import { describe, expect, it } from "vitest";
import {
  antigravityMeterCompactLabel,
  antigravityMeterLabel,
  antigravityMeterRank
} from "../src/index.js";

describe("Antigravity presentation", () => {
  it("shares labels, compact tags and stable ordering across surfaces", () => {
    expect([
      "FIVE_HOUR", "SEVEN_DAY", "THIRD_PARTY_SESSION", "THIRD_PARTY_WEEKLY"
    ].map((code) => ({
      label: antigravityMeterLabel(code),
      compact: antigravityMeterCompactLabel(code),
      rank: antigravityMeterRank(code)
    }))).toEqual([
      { label: "5 hour quota", compact: "5h", rank: 10 },
      { label: "Weekly quota", compact: "7d", rank: 20 },
      { label: "Third party 5 hour quota", compact: "3p5h", rank: 30 },
      { label: "Third party weekly quota", compact: "3p7d", rank: 40 }
    ]);
  });
});
