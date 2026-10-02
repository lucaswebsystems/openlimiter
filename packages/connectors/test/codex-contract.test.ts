import { normalizeMeters } from "@openlimiter/core";
import { describe, expect, it } from "vitest";
import {
  codexFixture,
  codexLabels,
  codexNoResetFixture,
  codexSanitizedLive,
  FIXTURE_NOW,
  parseCodexPayload
} from "../src/index.js";

const NOW = FIXTURE_NOW;
const reset = (seconds: number): number =>
  Math.floor(Date.parse(NOW) / 1_000) + seconds;

describe("codex documented app server response", () => {
  it("parses the standard five hour meter", () => {
    const meters = parseCodexPayload(codexFixture(NOW), NOW);
    expect(meters).toHaveLength(1);
    expect(meters?.[0]).toMatchObject({
      provider: "CODEX",
      meter: "FIVE_HOUR",
      value: 84,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: 18_000 },
      source: "documented_api",
      precision: "exact",
      labels: codexLabels
    });
  });

  it("parses the documented primary and secondary windows", () => {
    const meters = parseCodexPayload({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: reset(18_000) },
        secondary: { usedPercent: 47, windowDurationMins: 10_080, resetsAt: reset(604_800) }
      }
    }, NOW);
    expect(meters?.map((meter) => meter.meter)).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
  });

  it("keeps null duration windows with stable slot ids", () => {
    const meters = parseCodexPayload({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 23, windowDurationMins: null, resetsAt: null },
        secondary: { usedPercent: 47, windowDurationMins: null, resetsAt: null }
      }
    }, NOW);
    expect(meters?.map((meter) => meter.meter)).toEqual(["PRIMARY", "SECONDARY"]);
    expect(meters?.map((meter) => meter.window)).toEqual([
      { kind: "unknown" },
      { kind: "unknown" }
    ]);
  });

  it("keeps a window with no reset time", () => {
    const meters = parseCodexPayload(codexNoResetFixture(NOW), NOW);
    expect(meters).toHaveLength(1);
    expect(meters?.[0]).toMatchObject({ meter: "FIVE_HOUR", value: 73, resetAt: null });
  });

  it("reads named limits without duplicating the default", () => {
    const meters = parseCodexPayload({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: reset(18_000) }
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: reset(18_000) }
        },
        codexOther: {
          limitId: "codexOther",
          primary: { usedPercent: 61, windowDurationMins: 90, resetsAt: reset(5_400) }
        }
      }
    }, NOW);
    expect(meters?.map((meter) => meter.meter)).toEqual([
      "FIVE_HOUR",
      "CODEX_OTHER_WINDOW_90_MINUTE"
    ]);
  });

  it("renames both duplicate duration ids", () => {
    const meters = parseCodexPayload({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: reset(18_000) },
        secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: reset(17_000) }
      }
    }, NOW);
    expect(meters?.map((meter) => meter.meter)).toEqual([
      "FIVE_HOUR_PRIMARY",
      "FIVE_HOUR_SECONDARY"
    ]);
  });

  it("parses unlimited and finite credits", () => {
    const unlimited = parseCodexPayload({
      rateLimits: {
        limitId: "codex",
        credits: { unlimited: true },
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: reset(18_000) }
      }
    }, NOW);
    expect(unlimited?.find((meter) => meter.meter === "CREDITS"))
      .toMatchObject({ kind: "availability", availability: "unlimited" });

    const finite = parseCodexPayload({
      rateLimits: {
        limitId: "codex",
        credits: { hasCredits: true, balance: "12.5" },
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: reset(18_000) }
      }
    }, NOW);
    expect(finite?.find((meter) => meter.meter === "CREDITS"))
      .toMatchObject({ value: 12.5, unit: "CREDITS", window: { kind: "lifetime" } });
  });

  it("normalizes the documented meter end to end", () => {
    const normalized = normalizeMeters(parseCodexPayload(codexFixture(NOW), NOW) ?? []);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.meter).toBe("FIVE_HOUR");
  });

  it("uses the documented interface trust labels", () => {
    expect(codexLabels).toEqual({
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "documented-api",
      automationRisk: "low",
      verification: "VERIFIED_FIXTURES"
    });
  });

  it("replays the sanitized fixture through the documented shape", () => {
    expect(codexSanitizedLive.status).toBe("captured");
    expect(parseCodexPayload(codexSanitizedLive.build(NOW), NOW))
      .toHaveLength(codexSanitizedLive.expectedMeters);
  });
});

describe("codex documented response drift", () => {
  for (const [name, payload] of [
    ["the retired private response", { rate_limit: { primary_window: { used_percent: 84 } } }],
    ["an empty object", {}],
    ["an array", []],
    ["a missing percentage", { rateLimits: { limitId: "codex", primary: { windowDurationMins: 300 } } }],
    ["a string percentage", { rateLimits: { limitId: "codex", primary: { usedPercent: "23", windowDurationMins: 300 } } }],
    ["an invalid duration", { rateLimits: { limitId: "codex", primary: { usedPercent: 23, windowDurationMins: 0 } } }],
    ["a corrupt reset", { rateLimits: { limitId: "codex", primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: "soon" } } }]
  ] as const) {
    it("refuses " + name, () => {
      expect(parseCodexPayload(payload, NOW)).toBeNull();
    });
  }
});
