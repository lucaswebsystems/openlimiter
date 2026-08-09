import { describe, expect, it } from "vitest";
import { buildAdvice } from "../src/index.js";
import { snapshot } from "./helpers.js";

const now = "2026-01-01T00:01:00.000Z";

describe("policy", () => {
  it("injects nothing when every provider is unknown", () => {
    expect(buildAdvice([], now, ["CLAUDE", "CODEX"])).toEqual({
      inject: false,
      reason: "UNKNOWN",
      providers: [],
      unknownProviders: ["CLAUDE", "CODEX"]
    });
  });

  it("uses bounded codes and identifies unknown providers", () => {
    expect(buildAdvice([snapshot({ value: 82 })], now, ["CLAUDE", "CODEX"])).toEqual({
      inject: true,
      reason: "NEAR_CAP",
      providers: [{
        provider: "CLAUDE",
        state: "fresh",
        usagePercent: 82,
        resetAt: "2026-01-01T05:00:00.000Z"
      }],
      unknownProviders: ["CODEX"]
    });
  });

  it("uses the worst meter for a provider", () => {
    const advice = buildAdvice(
      [snapshot({ value: 10 }), snapshot({ value: 100, meter: "SEVEN_DAY" })],
      now,
      ["CLAUDE"]
    );
    expect(advice.reason).toBe("AT_CAP");
    expect(advice.providers[0]?.usagePercent).toBe(100);
  });
});
