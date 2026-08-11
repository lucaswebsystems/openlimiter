import { describe, expect, it } from "vitest";
import {
  REFRESH_BACKOFF_CEILING_SECONDS,
  REFRESH_FALLBACK_BASE_SECONDS,
  REFRESH_RETRY_AFTER_CEILING_SECONDS,
  SCHEDULE_EXEMPT_INSTANT,
  isDue,
  nextRefreshAt,
  refreshDelaySeconds
} from "../src/index.js";

/** No jitter: the midpoint of the range leaves the computed delay alone. */
const middle = (): number => 0.5;
const lowest = (): number => 0;
const highest = (): number => 1;

const NOW = "2026-01-01T00:00:00.000Z";

describe("refresh delay", () => {
  it.each([
    [0, 60],
    [1, 120],
    [2, 240],
    [3, 480],
    [4, 960],
    [5, 1_920]
  ])("doubles for attempt %s", (attempt, expected) => {
    expect(refreshDelaySeconds({ attempt, baseSeconds: 60, random: middle }))
      .toBe(expected);
  });

  it("stops growing at the ceiling", () => {
    for (const attempt of [6, 10, 40, 1_000, Number.MAX_SAFE_INTEGER]) {
      expect(refreshDelaySeconds({ attempt, baseSeconds: 60, random: middle }))
        .toBe(REFRESH_BACKOFF_CEILING_SECONDS);
    }
  });

  it("jitters up to a fifth either side", () => {
    expect(refreshDelaySeconds({ attempt: 0, baseSeconds: 100, random: lowest }))
      .toBeCloseTo(80, 10);
    expect(refreshDelaySeconds({ attempt: 0, baseSeconds: 100, random: highest }))
      .toBeCloseTo(120, 10);
    expect(refreshDelaySeconds({ attempt: 0, baseSeconds: 100, random: () => 0.75 }))
      .toBeCloseTo(110, 10);
  });

  it("honours a Retry-After that is longer than our own backoff", () => {
    expect(refreshDelaySeconds({
      attempt: 0,
      baseSeconds: 60,
      retryAfterSeconds: 900,
      random: middle
    })).toBe(900);
  });

  it("ignores a Retry-After shorter than our own backoff", () => {
    expect(refreshDelaySeconds({
      attempt: 3,
      baseSeconds: 60,
      retryAfterSeconds: 5,
      random: middle
    })).toBe(480);
  });

  /**
   * The one case jitter must never touch.
   *
   * Jitter subtracts up to a fifth. Applied to a Retry-After of a day that
   * would be a retry 4.8 hours before the provider allowed, which is worse
   * than no backoff at all. The header is a floor, so every random value has
   * to land at or above it.
   */
  const randomSources: readonly [string, () => number][] = [
    ["the lowest random", lowest],
    ["the highest random", highest],
    ["the midpoint", middle],
    ["a quarter", () => 0.25]
  ];

  it.each(randomSources)("never retries before a Retry-After of a day, with %s", (
    _name,
    random
  ) => {
    const delay = refreshDelaySeconds({
      attempt: 0,
      baseSeconds: 60,
      retryAfterSeconds: 86_400,
      random
    });
    expect(delay).toBeGreaterThanOrEqual(86_400);
    expect(delay).toBe(86_400);
  });

  it("keeps Retry-After as a floor even when jitter cuts the backoff below it", () => {
    /* Backoff 1000 jittered down by a fifth is 800, under the 900 asked for. */
    expect(refreshDelaySeconds({
      attempt: 0,
      baseSeconds: 1_000,
      retryAfterSeconds: 900,
      random: lowest
    })).toBe(900);
    /* Jittered up it is 1200, which is already past the floor and stands. */
    expect(refreshDelaySeconds({
      attempt: 0,
      baseSeconds: 1_000,
      retryAfterSeconds: 900,
      random: highest
    })).toBeCloseTo(1_200, 10);
  });

  it("still jitters our own backoff when a Retry-After is present but smaller", () => {
    const low = refreshDelaySeconds({
      attempt: 2,
      baseSeconds: 100,
      retryAfterSeconds: 10,
      random: lowest
    });
    const high = refreshDelaySeconds({
      attempt: 2,
      baseSeconds: 100,
      retryAfterSeconds: 10,
      random: highest
    });
    expect(low).toBeCloseTo(320, 10);
    expect(high).toBeCloseTo(480, 10);
    expect(low).not.toBe(high);
  });

  it("lets a long Retry-After exceed our ceiling but not run away", () => {
    expect(refreshDelaySeconds({
      attempt: 0,
      baseSeconds: 60,
      retryAfterSeconds: 7_200,
      random: middle
    })).toBe(7_200);
    expect(refreshDelaySeconds({
      attempt: 0,
      baseSeconds: 60,
      retryAfterSeconds: 9e12,
      random: middle
    })).toBe(REFRESH_RETRY_AFTER_CEILING_SECONDS);
  });

  const unusableRetryAfter: readonly [string, number][] = [
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["negative", -30],
    ["zero", 0]
  ];

  it.each(unusableRetryAfter)("ignores a Retry-After that is %s", (
    _name,
    retryAfterSeconds
  ) => {
    expect(refreshDelaySeconds({
      attempt: 0,
      baseSeconds: 60,
      retryAfterSeconds,
      random: middle
    })).toBe(60);
  });

  it("survives a hostile random source", () => {
    const values = [
      refreshDelaySeconds({ attempt: 0, baseSeconds: 60, random: () => Number.NaN }),
      refreshDelaySeconds({ attempt: 0, baseSeconds: 60, random: () => 9e300 }),
      refreshDelaySeconds({ attempt: 0, baseSeconds: 60, random: () => -5 }),
      refreshDelaySeconds({
        attempt: 0,
        baseSeconds: 60,
        random: () => {
          throw new Error("no random today");
        }
      })
    ];
    for (const value of values) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(48);
      expect(value).toBeLessThanOrEqual(72);
    }
  });

  it("never turns a missing or invalid cadence into one second polling", () => {
    expect(refreshDelaySeconds({ attempt: 0, baseSeconds: -60, random: middle }))
      .toBe(REFRESH_FALLBACK_BASE_SECONDS);
    expect(refreshDelaySeconds({
      attempt: 0,
      baseSeconds: Number.NaN,
      random: middle
    })).toBe(REFRESH_FALLBACK_BASE_SECONDS);
  });

  it("marks zero as schedule exempt", () => {
    expect(refreshDelaySeconds({ attempt: 0, baseSeconds: 0, random: middle }))
      .toBe(Number.POSITIVE_INFINITY);
  });
});

describe("next refresh instant", () => {
  it("adds the delay to the supplied clock", () => {
    expect(nextRefreshAt(NOW, { attempt: 0, baseSeconds: 60, random: middle }))
      .toBe("2026-01-01T00:01:00.000Z");
    expect(nextRefreshAt(NOW, { attempt: 3, baseSeconds: 60, random: middle }))
      .toBe("2026-01-01T00:08:00.000Z");
    expect(nextRefreshAt(NOW, { attempt: 0, baseSeconds: 100, random: lowest }))
      .toBe("2026-01-01T00:01:20.000Z");
  });

  it("refuses to guess from a clock it cannot read", () => {
    expect(nextRefreshAt("not a date", { attempt: 0, baseSeconds: 60, random: middle }))
      .toBeNull();
  });

  it("keeps a manual connection out of the background schedule", () => {
    expect(nextRefreshAt(NOW, { attempt: 0, baseSeconds: 0, random: middle }))
      .toBe(SCHEDULE_EXEMPT_INSTANT);
  });
});

describe("due check", () => {
  it("compares absolute instants", () => {
    expect(isDue("2026-01-01T00:00:01.000Z", NOW)).toBe(false);
    expect(isDue("2026-01-01T00:00:00.000Z", NOW)).toBe(true);
    expect(isDue("2025-12-31T23:59:59.000Z", NOW)).toBe(true);
  });

  it("treats a schedule it cannot read as due", () => {
    expect(isDue(null, NOW)).toBe(true);
    expect(isDue("not a date", NOW)).toBe(true);
  });

  it("treats a clock it cannot read as not due", () => {
    expect(isDue("2026-01-01T00:00:00.000Z", "not a date")).toBe(false);
  });
});
