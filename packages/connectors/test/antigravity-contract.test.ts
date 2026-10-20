import { describe, expect, it } from "vitest";
import { antigravityLabels, parseAntigravityPayload } from "../src/index.js";

const NOW = "2026-10-02T12:00:00.000Z";

function payload(quota: Record<string, unknown>): Record<string, unknown> {
  return { email: "person@example.com", quota };
}

describe("Antigravity documented status line payload", () => {
  it("maps every known quota bucket and omits unknown buckets", () => {
    const meters = parseAntigravityPayload(payload({
      "gemini-5h": { remaining_fraction: 0.75, reset_in_seconds: 9 },
      "gemini-weekly": { remaining_fraction: 0.5, reset_time: "2026-10-09T12:00:00Z" },
      "3p-5h": { remaining_fraction: 0.25 },
      "3p-weekly": { remaining_fraction: 0 },
      "future-monthly": { remaining_fraction: 0.9 }
    }), NOW);

    expect(meters?.map((meter) => meter.meter)).toEqual([
      "FIVE_HOUR", "SEVEN_DAY", "THIRD_PARTY_SESSION", "THIRD_PARTY_WEEKLY"
    ]);
    expect(meters?.map((meter) => meter.value)).toEqual([25, 50, 75, 100]);
  });

  it("does not invent a reset instant from a countdown", () => {
    const meters = parseAntigravityPayload(payload({
      "gemini-5h": { remaining_fraction: 0.5, reset_in_seconds: 18_000 }
    }), NOW);
    expect(meters?.[0]?.resetAt).toBeNull();
    expect(meters?.[0]?.window).toEqual({ kind: "rolling", durationSeconds: 18_000 });
  });

  it("uses invocation time for observation age and documented labels", () => {
    const meters = parseAntigravityPayload(payload({
      "gemini-weekly": { remaining_fraction: 0.2 }
    }), NOW);
    expect(meters?.[0]?.observedAt).toBe(NOW);
    expect(meters?.[0]?.expiresAt).toBe("2026-10-02T12:01:00.000Z");
    expect(meters?.[0]?.labels).toEqual(antigravityLabels);
  });

  it("treats a missing quota object as no update", () => {
    expect(parseAntigravityPayload({ email: "person@example.com" }, NOW)).toBeNull();
  });

  /* A pool the documented four do not name is its own row, under the code the
     desktop's twin gives it (native_readers.rs antigravity_meter). */
  it("names a new pool after itself beside the documented buckets", () => {
    const meters = parseAntigravityPayload(payload({
      "gemini-5h": { remaining_fraction: 0.75 },
      "gemini-weekly": { remaining_fraction: 0.5 },
      "argon-weekly": { remaining_fraction: 0.4 }
    }), NOW);
    expect(meters?.map((meter) => [meter.meter, meter.value])).toEqual([
      ["FIVE_HOUR", 25], ["SEVEN_DAY", 50], ["ARGON_WEEKLY", 60]
    ]);
  });

  it("reads a payload that carries only a new pool instead of returning nothing", () => {
    const meters = parseAntigravityPayload(payload({
      "argon-5h": { remaining_fraction: 0.9 },
      "argon-weekly": { remaining_fraction: 0.4 }
    }), NOW);
    expect(meters?.map((meter) => [meter.meter, meter.window])).toEqual([
      ["ARGON_SESSION", { kind: "rolling", durationSeconds: 18_000 }],
      ["ARGON_WEEKLY", { kind: "rolling", durationSeconds: 604_800 }]
    ]);
  });

  it("never turns a longer gemini bucket into a second Gemini weekly", () => {
    const meters = parseAntigravityPayload(payload({
      "gemini-weekly": { remaining_fraction: 0.5 },
      "gemini-4-argon-weekly": { remaining_fraction: 0.4 }
    }), NOW);
    expect(meters?.map((meter) => [meter.meter, meter.value])).toEqual([
      ["SEVEN_DAY", 50], ["GEMINI_4_ARGON_WEEKLY", 60]
    ]);
  });
});
