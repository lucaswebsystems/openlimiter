import { describe, expect, it } from "vitest";
import { buildAdvice } from "../src/index.js";
import { snapshot } from "./helpers.js";

const now = "2026-01-01T00:01:00.000Z";

describe("policy", () => {
  it("injects nothing when every provider is unknown", () => {
    expect(buildAdvice([], now, ["CLAUDE", "CODEX"])).toEqual({
      inject: false,
      reason: "UNKNOWN",
      recommendation: {
        code: "NONE",
        provider: null,
        reason: "NO_KNOWN_PROVIDER"
      },
      providers: [],
      unknownProviders: ["CLAUDE", "CODEX"]
    });
  });

  it("uses bounded codes and identifies unknown providers", () => {
    expect(buildAdvice([snapshot({ value: 82 })], now, ["CLAUDE", "CODEX"])).toEqual({
      inject: true,
      reason: "NEAR_CAP",
      recommendation: {
        code: "NONE",
        provider: null,
        reason: "NO_HEALTHY_PROVIDER"
      },
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

  it("recommends the fresh provider with the lowest healthy usage", () => {
    const advice = buildAdvice([
      snapshot({ provider: "CLAUDE", value: 45 }),
      snapshot({ provider: "CODEX", value: 20 })
    ], now, ["CLAUDE", "CODEX"]);
    expect(advice.recommendation).toEqual({
      code: "PREFER",
      provider: "CODEX",
      reason: "LOWEST_USAGE"
    });
  });

  it("breaks a usage tie by expected provider order", () => {
    const advice = buildAdvice([
      snapshot({ provider: "CLAUDE", value: 20 }),
      snapshot({ provider: "CODEX", value: 20 })
    ], now, ["CODEX", "CLAUDE"]);
    expect(advice.recommendation).toEqual({
      code: "PREFER",
      provider: "CODEX",
      reason: "ORDERED_TIE_BREAK"
    });
  });

  it("recommends nothing when every fresh provider is near its cap", () => {
    const advice = buildAdvice([
      snapshot({ provider: "CLAUDE", value: 80 }),
      snapshot({ provider: "CODEX", value: 99 })
    ], now, ["CLAUDE", "CODEX"]);
    expect(advice.recommendation).toEqual({
      code: "NONE",
      provider: null,
      reason: "NO_HEALTHY_PROVIDER"
    });
  });

  it("never recommends stale data", () => {
    const advice = buildAdvice([
      snapshot({
        provider: "CLAUDE",
        value: 5,
        expiresAt: "2026-01-01T00:00:30.000Z"
      }),
      snapshot({ provider: "CODEX", value: 35 })
    ], now, ["CLAUDE", "CODEX"]);
    expect(advice.recommendation).toEqual({
      code: "PREFER",
      provider: "CODEX",
      reason: "LOWEST_USAGE"
    });
    expect(buildAdvice([
      snapshot({ expiresAt: "2026-01-01T00:00:30.000Z" })
    ], now, ["CLAUDE"]).recommendation).toEqual({
      code: "NONE",
      provider: null,
      reason: "NO_FRESH_DATA"
    });
  });
});
