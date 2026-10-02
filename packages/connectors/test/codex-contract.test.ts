import { normalizeMeters } from "@openlimiter/core";
import { describe, expect, it } from "vitest";
import {
  codexFixture,
  codexLabels,
  codexNoResetFixture,
  FIXTURE_NOW,
  parseCodexPayload
} from "../src/index.js";

const NOW = FIXTURE_NOW;

function resetAfter(seconds: number): number {
  return Math.floor(Date.parse(NOW) / 1_000) + seconds;
}

const documentedPayload = {
  accountId: "codex-824c7eddd1cf39d1d49b3ee8",
  rateLimits: {
    limitId: "codex",
    primary: {
      usedPercent: 23,
      windowDurationMins: 300,
      resetsAt: resetAfter(18_000)
    },
    secondary: {
      usedPercent: 47,
      windowDurationMins: 10_080,
      resetsAt: resetAfter(604_800)
    }
  }
};

describe("Codex documented app server response", () => {
  it("maps five hour and seven day windows by duration", () => {
    const meters = parseCodexPayload(documentedPayload, NOW);
    expect(meters?.map((meter) => meter.meter)).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
    expect(meters?.map((meter) => meter.value)).toEqual([23, 47]);
    expect(meters?.every((meter) => meter.source === "documented_api")).toBe(true);
    expect(meters?.every((meter) =>
      meter.accountId === "codex-824c7eddd1cf39d1d49b3ee8")).toBe(true);
  });

  it("accepts only the opaque account id injected by acquisition", () => {
    const meters = parseCodexPayload({
      ...documentedPayload,
      accountId: "synthetic-chatgpt-account"
    }, NOW);
    expect(meters?.every((meter) => meter.accountId === undefined)).toBe(true);
  });

  it("keeps an unknown duration as its own meter", () => {
    const meters = parseCodexPayload({
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 19,
          windowDurationMins: 90,
          resetsAt: resetAfter(5_400)
        }
      }
    }, NOW);
    expect(meters?.[0]).toMatchObject({
      meter: "WINDOW_90_MINUTE",
      window: { kind: "rolling", durationSeconds: 5_400 }
    });
  });

  it("keeps a null duration with a stable slot meter and unknown window", () => {
    const meters = parseCodexPayload({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 23, windowDurationMins: null, resetsAt: null },
        secondary: { usedPercent: 47, windowDurationMins: null, resetsAt: null }
      }
    }, NOW);
    expect(meters).toMatchObject([
      { meter: "PRIMARY", value: 23, window: { kind: "unknown" } },
      { meter: "SECONDARY", value: 47, window: { kind: "unknown" } }
    ]);
  });

  it("creates readable meters for limit id entries that carry windows", () => {
    const meters = parseCodexPayload({
      ...documentedPayload,
      rateLimitsByLimitId: {
        codex: documentedPayload.rateLimits,
        codex_other: {
          limitId: "codex_other",
          primary: {
            usedPercent: 61,
            windowDurationMins: 90,
            resetsAt: resetAfter(5_400)
          }
        },
        empty_bucket: { limitId: "empty_bucket", primary: null, secondary: null }
      }
    }, NOW);
    expect(meters?.map((meter) => meter.meter)).toEqual([
      "FIVE_HOUR",
      "SEVEN_DAY",
      "CODEX_OTHER_WINDOW_90_MINUTE"
    ]);

    const additionalOnly = parseCodexPayload({
      ...documentedPayload,
      rateLimitsByLimitId: {
        codex_other: {
          limitId: "codex_other",
          primary: {
            usedPercent: 61,
            windowDurationMins: 90,
            resetsAt: resetAfter(5_400)
          }
        }
      }
    }, NOW);
    expect(additionalOnly?.map((meter) => meter.meter)).toEqual([
      "FIVE_HOUR",
      "SEVEN_DAY",
      "CODEX_OTHER_WINDOW_90_MINUTE"
    ]);
  });

  it("adds credits only when the response carries them", () => {
    expect(parseCodexPayload(documentedPayload, NOW)?.some((meter) => meter.meter === "CREDITS"))
      .toBe(false);
    const meters = parseCodexPayload({
      ...documentedPayload,
      rateLimits: { ...documentedPayload.rateLimits, credits: { unlimited: true } }
    }, NOW);
    expect(meters?.find((meter) => meter.meter === "CREDITS")).toMatchObject({
      kind: "availability",
      availability: "unlimited"
    });
  });

  it("retains a documented window when resetsAt is absent", () => {
    const meters = parseCodexPayload(codexNoResetFixture(NOW), NOW);
    expect(meters).toHaveLength(1);
    expect(meters?.[0]).toMatchObject({ meter: "FIVE_HOUR", value: 73, resetAt: null });
    expect(normalizeMeters(meters ?? [])[0]?.resetAt).toBeNull();
  });

  it("uses documented low risk labels", () => {
    expect(parseCodexPayload(codexFixture(NOW), NOW)?.[0]?.labels).toEqual(codexLabels);
    expect(codexLabels).toEqual({
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "documented-api",
      automationRisk: "low",
      verification: "VERIFIED_FIXTURES"
    });
  });

  it("refuses malformed and legacy private endpoint shapes", () => {
    expect(parseCodexPayload({}, NOW)).toBeNull();
    expect(parseCodexPayload({
      rate_limit: {
        primary_window: {
          used_percent: 84,
          limit_window_seconds: 18_000,
          reset_at: resetAfter(18_000)
        }
      }
    }, NOW)).toBeNull();
  });
});
