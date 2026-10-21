import { describe, expect, it } from "vitest";
import { mergeSnapshots, normalizeMeters } from "@openlimiter/core";
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

  it.each([
    ["5h", "THIRD_PARTY_SESSION", "X_74686972642D7061727479_SESSION"],
    ["weekly", "THIRD_PARTY_WEEKLY", "X_74686972642D7061727479_WEEKLY"]
  ])("keeps third-party-%s separate from the documented 3p bar", (period, documented, unknown) => {
    const meters = parseAntigravityPayload(payload({
      [`3p-${period}`]: { remaining_fraction: 0.25 },
      [`third-party-${period}`]: { remaining_fraction: 0.4 }
    }), NOW);
    expect(meters?.map(row => [row.meter, row.value])).toEqual([
      [documented, 75], [unknown, 60]
    ]);
    const merged = mergeSnapshots([], normalizeMeters(meters ?? []));
    expect(merged).toHaveLength(2);
    expect(merged.find(row => row.meter === documented)?.value).toBe(75);
    expect(merged.find(row => row.meter === unknown)?.value).toBe(60);
  });

  // These exact identities are also asserted beside the Rust twin.
  it.each([
    ["argon-pro", "ARGON_PRO_SESSION", "argon_pro", "X_6172676F6E5F70726F_SESSION"],
    ["argon.pro", "X_6172676F6E2E70726F_SESSION", "argon_pro", "X_6172676F6E5F70726F_SESSION"],
    ["argon", "ARGON_SESSION", "Argon", "X_4172676F6E_SESSION"],
    ["third-party", "X_74686972642D7061727479_SESSION", "third_party", "X_74686972645F7061727479_SESSION"],
    [".", "X_2E_SESSION", "x-2e", "X_782D3265_SESSION"],
    ["a\u00e9", "X_61C3A9_SESSION", "a\u00e8", "X_61C3A8_SESSION"],
    ["a\u{1f600}", "X_61F09F9880_SESSION", "a\u{1f603}", "X_61F09F9883_SESSION"]
  ])("keeps %s distinct from its colliding pool", (first, firstCode, second, secondCode) => {
    for (const [period, firstMeter, secondMeter] of [
      ["5h", firstCode, secondCode],
      ["weekly", firstCode.replace(/_SESSION$/u, "_WEEKLY"), secondCode.replace(/_SESSION$/u, "_WEEKLY")]
    ] as const) {
      const quota = {
        [`${first}-${period}`]: { remaining_fraction: 0.25 },
        [`${second}-${period}`]: { remaining_fraction: 0.4 }
      };
      const meters = parseAntigravityPayload(payload(quota), NOW);
      expect(meters?.map(row => [row.meter, row.value])).toEqual([
        [firstMeter, 75], [secondMeter, 60]
      ]);
      expect(mergeSnapshots([], normalizeMeters(meters ?? []))).toHaveLength(2);
      // A code depends only on the bucket, never its neighbours or their order.
      for (const [bucket, code] of [[`${first}-${period}`, firstMeter], [`${second}-${period}`, secondMeter]] as const) {
        expect(parseAntigravityPayload(payload({ [bucket]: quota[bucket] }), NOW)?.[0]?.meter).toBe(code);
      }
    }
  });

  it.each([
    ["5h", "a".repeat(24), "A".repeat(24) + "_SESSION", "a".repeat(25)],
    ["weekly", "a".repeat(25), "A".repeat(25) + "_WEEKLY", "a".repeat(26)],
    ["5h", "a".repeat(10) + "_", "X_" + "61".repeat(10) + "5F_SESSION", "a".repeat(11) + "_"],
    ["weekly", "a".repeat(10) + "_", "X_" + "61".repeat(10) + "5F_WEEKLY", "a".repeat(11) + "_"]
  ])("bounds the complete %s code, including encoding and cadence", (period, accepted, expected, rejected) => {
    const meters = parseAntigravityPayload(payload({
      [`${accepted}-${period}`]: { remaining_fraction: 0.25 },
      [`${rejected}-${period}`]: { remaining_fraction: 0.4 }
    }), NOW);
    expect(meters?.map(row => row.meter)).toEqual([expected]);
    expect(normalizeMeters(meters ?? [])).toHaveLength(1);
    expect(expected.length).toBeLessThanOrEqual(32);
    expect(parseAntigravityPayload(payload({
      [`${rejected}-${period}`]: { remaining_fraction: 0.4 }
    }), NOW)).toBeNull();
  });

  it("rejects malformed Unicode rather than aliasing the replacement character", () => {
    const meters = parseAntigravityPayload(payload({
      "a\ud800-5h": { remaining_fraction: 0.25 },
      "a\ufffd-5h": { remaining_fraction: 0.4 }
    }), NOW);
    expect(meters?.map(row => row.meter)).toEqual(["X_61EFBFBD_SESSION"]);
  });
});
