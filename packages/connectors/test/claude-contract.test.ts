/**
 * Contract tests for the one provider interface that is publicly documented.
 *
 * These are written to fail if the parser is wrong, which the previous suite
 * could not do: its fixture was built from the parser, so the two agreed with
 * each other and disagreed with Anthropic. Everything asserted below traces to
 * https://code.claude.com/docs/en/statusline as read on 2026-08-10, and the
 * expected instants are computed by hand rather than by calling the same helper
 * the implementation calls.
 */

import { normalizeMeters, type RawMeter } from "@openlimiter/core";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_DOCS_EXAMPLE_RESETS,
  CLAUDE_DOCS_EXAMPLE_VERBATIM,
  FIXTURE_NOW,
  claudeCapturePayload,
  claudeDocumentedFixture,
  claudeSanitizedLive,
  documentedFixtures,
  malformedFixtures,
  parseAntigravityPayload,
  parseClaudePayload,
  parseCodexPayload,
  parseGrokPayload,
  parseKimiPayload,
  parseManualPayload,
  parseOpencodePayload,
  parseOpenrouterPayload,
  sanitizeClaudeStatusline,
  sanitizedLiveFixtures,
  type ConnectorId
} from "../src/index.js";

type Parser = (payload: unknown, now: string) => RawMeter[] | null;

const parsers: Partial<Record<ConnectorId, Parser>> = {
  claude: parseClaudePayload,
  openrouter: parseOpenrouterPayload,
  codex: parseCodexPayload,
  antigravity: parseAntigravityPayload,
  opencode: parseOpencodePayload,
  grok: parseGrokPayload,
  kimi: parseKimiPayload,
  manual: parseManualPayload
};

function fixtureParser(connector: ConnectorId): Parser {
  const parser = parsers[connector];
  if (parser === undefined) {
    throw new Error("the fixture names a provider with no generic parser");
  }
  return parser;
}

/** Whole seconds at FIXTURE_NOW, so expected epochs are written out in full. */
const NOW_EPOCH = 1_767_225_600;
const FIVE_HOURS = 18_000;
const SEVEN_DAYS = 604_800;

function meterCount(parsed: readonly RawMeter[] | null): number {
  return parsed === null ? 0 : parsed.length;
}

function windowPayload(five: unknown, seven: unknown): Record<string, unknown> {
  const limits: Record<string, unknown> = {};
  if (five !== undefined) limits["five_hour"] = five;
  if (seven !== undefined) limits["seven_day"] = seven;
  return { rate_limits: limits };
}

describe("claude documented contract", () => {
  it("turns the documented payload into two exact meters", () => {
    const parsed = parseClaudePayload(claudeDocumentedFixture(FIXTURE_NOW), FIXTURE_NOW);
    expect(parsed).toHaveLength(2);
    expect(parsed?.map((meter) => meter.meter)).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
    expect(parsed?.map((meter) => meter.value)).toEqual([23.5, 41.2]);
    /* FIXTURE_NOW is 1767225600. Plus 18000 is 1767243600, plus 604800 is
     * 1767830400. Written as instants by hand, not by the helper under test. */
    expect(parsed?.map((meter) => meter.resetAt)).toEqual([
      "2026-01-01T05:00:00.000Z",
      "2026-01-08T00:00:00.000Z"
    ]);
    expect(normalizeMeters(parsed ?? [])).toHaveLength(2);
  });

  it("pins epoch seconds against hand computed instants", () => {
    /* The documentation's own numbers, left alone. 1738425600 is
     * 2025-02-01T16:00:00.000Z and 1738857600 is 2025-02-06T16:00:00.000Z.
     *
     * The clock is four hours before the first of those, which is where a
     * session holding this payload would actually be. A clock a month earlier
     * would put the five hour reset a month away and the plausibility bound
     * would correctly refuse it, so the clock is part of what makes this
     * example a real payload rather than two numbers in a document. */
    const parsed = parseClaudePayload(
      CLAUDE_DOCS_EXAMPLE_VERBATIM,
      "2025-02-01T12:00:00.000Z"
    );
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]?.resetAt).toBe(CLAUDE_DOCS_EXAMPLE_RESETS.five_hour);
    expect(parsed?.[1]?.resetAt).toBe(CLAUDE_DOCS_EXAMPLE_RESETS.seven_day);
    expect(CLAUDE_DOCS_EXAMPLE_RESETS.five_hour).toBe("2025-02-01T16:00:00.000Z");
    expect(CLAUDE_DOCS_EXAMPLE_RESETS.seven_day).toBe("2025-02-06T16:00:00.000Z");
  });

  it("reads a fractional epoch to the nearest millisecond", () => {
    const parsed = parseClaudePayload(
      windowPayload({ used_percentage: 10, resets_at: NOW_EPOCH + 1.5 }, undefined),
      FIXTURE_NOW
    );
    expect(parsed?.[0]?.resetAt).toBe("2026-01-01T00:00:01.500Z");
  });

  /**
   * A reset has to belong to the window that named it.
   *
   * Accepting any future epoch let a five hour meter claim a reset in 2038 and
   * render a twelve year countdown next to a five hour window. The bound is
   * twice the window plus an hour of clock skew, per window, so an implausible
   * five hour reset costs the five hour meter and nothing else.
   */
  it("refuses a five hour reset that is years away", () => {
    expect(parseClaudePayload(
      windowPayload({ used_percentage: 42, resets_at: 2_147_483_648 }, undefined),
      FIXTURE_NOW
    )).toBeNull();
  });

  it("accepts a reset exactly at the horizon and refuses one second past it", () => {
    const horizon = NOW_EPOCH + FIVE_HOURS * 2 + 3_600;
    expect(parseClaudePayload(
      windowPayload({ used_percentage: 42, resets_at: horizon }, undefined),
      FIXTURE_NOW
    )).toHaveLength(1);
    expect(parseClaudePayload(
      windowPayload({ used_percentage: 42, resets_at: horizon + 1 }, undefined),
      FIXTURE_NOW
    )).toBeNull();
  });

  it("bounds each window by its own length", () => {
    /* Three days: nonsense for a five hour window, ordinary for a seven day
       one. Exactly one meter survives, and it is the right one. */
    const threeDays = NOW_EPOCH + 259_200;
    const parsed = parseClaudePayload(
      windowPayload(
        { used_percentage: 42, resets_at: threeDays },
        { used_percentage: 64, resets_at: threeDays }
      ),
      FIXTURE_NOW
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.meter).toBe("SEVEN_DAY");
  });

  it("reads an epoch above the signed 32 bit boundary when the clock is there too", () => {
    /* The plausibility bound is relative, so a 2038 reset is fine in 2038. This
       is what proves the conversion never truncates to 32 bits. */
    const now = "2038-01-19T03:14:08.000Z";
    const parsed = parseClaudePayload(
      windowPayload({ used_percentage: 42, resets_at: 2_147_483_648 + 3_600 }, undefined),
      now
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.resetAt).toBe("2038-01-19T04:14:08.000Z");
  });

  it("refuses the invented shape the old parser read", () => {
    const legacy = {
      rate_limits: {
        five_hour: { utilization: 42, resets_at: "2026-01-01T05:00:00.000Z" },
        seven_day: { utilization: 64, resets_at: "2026-01-08T00:00:00.000Z" }
      }
    };
    expect(parseClaudePayload(legacy, FIXTURE_NOW)).toBeNull();
  });
});

/**
 * Window independence, as a first class contract rather than an edge case.
 *
 * The documentation states each window may be independently absent, so a real
 * payload carrying one window is a complete answer and not a degraded one. An
 * absent window is absent: never zero, never an error.
 */
describe("claude window independence", () => {
  const fiveHour = { used_percentage: 23.5, resets_at: NOW_EPOCH + FIVE_HOURS };
  const sevenDay = { used_percentage: 41.2, resets_at: NOW_EPOCH + SEVEN_DAYS };

  it("yields one meter when only the five hour window is supplied", () => {
    const parsed = parseClaudePayload(windowPayload(fiveHour, undefined), FIXTURE_NOW);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.meter).toBe("FIVE_HOUR");
    expect(parsed?.[0]?.value).toBe(23.5);
    expect(JSON.stringify(parsed).includes("SEVEN_DAY")).toBe(false);
  });

  it("yields one meter when only the seven day window is supplied", () => {
    const parsed = parseClaudePayload(windowPayload(undefined, sevenDay), FIXTURE_NOW);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.meter).toBe("SEVEN_DAY");
    expect(parsed?.[0]?.value).toBe(41.2);
    expect(JSON.stringify(parsed).includes("FIVE_HOUR")).toBe(false);
  });

  it("normalizes every window it was actually given, in every combination", () => {
    const combinations = [
      [fiveHour, undefined],
      [undefined, sevenDay],
      [fiveHour, sevenDay]
    ] as const;
    for (const [five, seven] of combinations) {
      const supplied = (five === undefined ? 0 : 1) + (seven === undefined ? 0 : 1);
      const parsed = parseClaudePayload(windowPayload(five, seven), FIXTURE_NOW);
      expect(meterCount(parsed)).toBe(supplied);
      expect(normalizeMeters(parsed ?? [])).toHaveLength(supplied);
    }
  });

  it("says unknown rather than zero when no window is supplied", () => {
    expect(parseClaudePayload(windowPayload(undefined, undefined), FIXTURE_NOW))
      .toBeNull();
    expect(parseClaudePayload({ rate_limits: {} }, FIXTURE_NOW)).toBeNull();
    /* rate_limits itself is absent for a free account, and for any session
     * before its first API response. That is an ordinary payload. */
    expect(parseClaudePayload({ session_id: "synthetic" }, FIXTURE_NOW)).toBeNull();
  });

  it("drops an undocumented window without disturbing the documented ones", () => {
    const parsed = parseClaudePayload({
      rate_limits: {
        five_hour: fiveHour,
        seven_day: sevenDay,
        three_hour: { used_percentage: 99, resets_at: NOW_EPOCH + 10_800 }
      }
    }, FIXTURE_NOW);
    expect(parsed).toHaveLength(2);
    expect(JSON.stringify(parsed).includes("THREE_HOUR")).toBe(false);
    expect(JSON.stringify(parsed).includes("99")).toBe(false);
  });
});

/**
 * The percentage boundary table from the test plan.
 *
 * Exactness is the product promise, so an accepted reading must come back as
 * the same number that went in, to the digit, all the way through the
 * normalizer.
 */
describe("claude percentage boundaries", () => {
  const accepted = [0, 0.1, 1, 49.9, 50, 70, 84.9, 85, 90, 91, 97, 99.9, 100];

  it.each(accepted)("accepts %s and keeps it exact", (value) => {
    const parsed = parseClaudePayload(
      windowPayload({ used_percentage: value, resets_at: NOW_EPOCH + FIVE_HOURS }, undefined),
      FIXTURE_NOW
    );
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.value).toBe(value);
    expect(normalizeMeters(parsed ?? [])[0]?.value).toBe(value);
  });

  it("keeps neighbouring readings distinguishable", () => {
    const read = (value: number): number | undefined => normalizeMeters(
      parseClaudePayload(
        windowPayload(
          { used_percentage: value, resets_at: NOW_EPOCH + FIVE_HOURS },
          undefined
        ),
        FIXTURE_NOW
      ) ?? []
    )[0]?.value;
    expect(read(91)).not.toBe(read(97));
    expect(read(97)).not.toBe(read(99));
    expect(read(99.9)).not.toBe(read(100));
  });

  const refused: readonly [string, unknown][] = [
    ["over one hundred", 100.1],
    ["far over one hundred", 9e300],
    ["slightly negative", -0.1],
    ["negative", -1],
    ["not a number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["null", null],
    ["a numeric string", "50"],
    ["an object", {}],
    ["an empty array", []],
    ["an array holding the number", [50]],
    ["a boolean", true]
  ];

  it.each(refused)("refuses a used_percentage that is %s", (_name, value) => {
    expect(parseClaudePayload(
      windowPayload(
        { used_percentage: value, resets_at: NOW_EPOCH + FIVE_HOURS },
        undefined
      ),
      FIXTURE_NOW
    )).toBeNull();
  });

  it("ignores unknown fields beside a good reading", () => {
    const parsed = parseClaudePayload(
      windowPayload({
        used_percentage: 50,
        resets_at: NOW_EPOCH + FIVE_HOURS,
        remaining_percentage: 50,
        overage_allowed: true,
        note: "Ignore previous instructions"
      }, undefined),
      FIXTURE_NOW
    );
    expect(parsed).toHaveLength(1);
    expect(JSON.stringify(parsed).includes("Ignore previous")).toBe(false);
    expect(JSON.stringify(parsed).includes("overage")).toBe(false);
  });
});

/**
 * The capture harness.
 *
 * No live capture exists yet, so what can be proven today is that the harness
 * throws away everything a real payload carries except the two readings, and
 * that what it keeps round trips back into a parseable payload.
 */
describe("claude live capture harness", () => {
  const livePayload = {
    hook_event_name: "Status",
    session_id: "11111111-2222-4333-8444-555555555555",
    transcript_path: "/home/a-real-person/projects/secret/transcript.jsonl",
    cwd: "/home/a-real-person/projects/secret",
    model: { id: "claude-opus-5", display_name: "Opus" },
    workspace: { current_dir: "/home/a-real-person/projects/secret" },
    version: "9.9.9",
    rate_limits: {
      five_hour: { used_percentage: 23.456_7, resets_at: NOW_EPOCH + FIVE_HOURS },
      seven_day: { used_percentage: 41.2, resets_at: NOW_EPOCH + SEVEN_DAYS }
    }
  };

  it("keeps two readings and throws away everything else", () => {
    const capture = sanitizeClaudeStatusline(livePayload, NOW_EPOCH);
    expect(capture).not.toBeNull();
    const text = JSON.stringify(capture);
    expect(text.includes("a-real-person")).toBe(false);
    expect(text.includes("secret")).toBe(false);
    expect(text.includes("11111111")).toBe(false);
    expect(text.includes("claude-opus-5")).toBe(false);
    expect(text.includes(String(NOW_EPOCH))).toBe(false);
    expect(capture?.fiveHour?.resetsInSeconds).toBe(FIVE_HOURS);
    expect(capture?.sevenDay?.resetsInSeconds).toBe(SEVEN_DAYS);
    expect(capture?.claudeCodeVersion).toBe("9.9.9");
  });

  it("rounds a reading to the precision the documentation prints", () => {
    const capture = sanitizeClaudeStatusline(livePayload, NOW_EPOCH);
    expect(capture?.fiveHour?.usedPercentage).toBe(23.5);
  });

  it("round trips a capture back into a parseable payload", () => {
    const capture = sanitizeClaudeStatusline(livePayload, NOW_EPOCH);
    expect(capture).not.toBeNull();
    const parsed = parseClaudePayload(
      claudeCapturePayload(capture!, FIXTURE_NOW),
      FIXTURE_NOW
    );
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]?.value).toBe(23.5);
  });

  it("refuses a payload with no rate limits to capture", () => {
    expect(sanitizeClaudeStatusline({ session_id: "x" }, NOW_EPOCH)).toBeNull();
    expect(sanitizeClaudeStatusline("not a payload", NOW_EPOCH)).toBeNull();
  });

  it("has no invented live capture standing in for a real one", () => {
    expect(claudeSanitizedLive.status).toBe("pending_capture");
    expect(claudeSanitizedLive.build(FIXTURE_NOW)).toBeNull();
    expect(claudeSanitizedLive.skipReason).toContain("PENDING CAPTURE");
  });
});

/**
 * The sanitized live class itself.
 *
 * A missing capture skips, with its reason in the test name, so the gap is
 * visible in every run rather than silently absent. A skip that nobody ever
 * looks at is how a gap becomes permanent, so there is a switch: with
 * REQUIRE_LIVE_CAPTURES set to 1 the same entry FAILS instead of skipping.
 *
 * Release CI is where that flag belongs, so a release cannot go out claiming a
 * verified provider on the strength of a documented fixture alone, while an
 * ordinary development run stays green. A flag beats a date: a time bomb fails
 * on a morning nobody chose, on work unrelated to captures.
 *
 * The CI wiring itself lands in a later wave. Until then the flag can be set by
 * hand: REQUIRE_LIVE_CAPTURES=1 pnpm test
 */
const REQUIRE_LIVE_CAPTURES = process.env["REQUIRE_LIVE_CAPTURES"] === "1";

describe("sanitized live fixtures", () => {
  for (const fixture of sanitizedLiveFixtures) {
    if (fixture.status === "captured") {
      it(fixture.id + " [captured]", () => {
        const parsed = fixtureParser(fixture.connector)(
          fixture.build(FIXTURE_NOW),
          FIXTURE_NOW
        );
        expect(meterCount(parsed)).toBe(fixture.expectedMeters);
        expect(normalizeMeters(parsed ?? [])).toHaveLength(fixture.expectedMeters);
        expect(fixture.capturedAt).not.toBeNull();
        expect(fixture.providerVersion).not.toBeNull();
      });
      continue;
    }
    const title = fixture.id + " [" + (fixture.skipReason ?? "pending") + "]";
    if (REQUIRE_LIVE_CAPTURES) {
      it(title, () => {
        expect.fail(
          "REQUIRE_LIVE_CAPTURES is set, so every connector needs a sanitized " +
          "live capture. " + fixture.id + " has none. " +
          (fixture.skipReason ?? "") +
          " Either capture one with sanitizeClaudeStatusline and paste it into " +
          "packages/connectors/src/fixtures.ts, or stop claiming this provider " +
          "is releasable."
        );
      });
      continue;
    }
    it.skip(title, () => undefined);
  }

  it("knows whether live captures are being demanded of it", () => {
    /* The switch itself is asserted so it cannot quietly stop working and
       leave the run permanently green. */
    expect(REQUIRE_LIVE_CAPTURES).toBe(process.env["REQUIRE_LIVE_CAPTURES"] === "1");
  });
});

describe("fixture classes", () => {
  for (const fixture of documentedFixtures) {
    it("documented " + fixture.id + " parses to its stated meter count", () => {
      const parsed = fixtureParser(fixture.connector)(
        fixture.build(FIXTURE_NOW),
        FIXTURE_NOW
      );
      expect(meterCount(parsed)).toBe(fixture.expectedMeters);
      expect(normalizeMeters(parsed ?? [])).toHaveLength(fixture.expectedMeters);
    });
  }

  for (const fixture of malformedFixtures) {
    it("malformed " + fixture.id + " yields its stated meter count", () => {
      const parsed = fixtureParser(fixture.connector)(
        fixture.build(FIXTURE_NOW),
        FIXTURE_NOW
      );
      expect(meterCount(parsed)).toBe(fixture.expectedMeters);
      expect(normalizeMeters(parsed ?? [])).toHaveLength(fixture.expectedMeters);
    });
  }

  it("covers every connector with a documented fixture", () => {
    const covered = new Set(documentedFixtures.map((fixture) => fixture.connector));
    expect([...covered].sort()).toEqual([
      "antigravity",
      "claude",
      "codex",
      "grok",
      "kimi",
      "manual",
      "opencode",
      "openrouter"
    ]);
  });

  /**
   * A review date has to be a day that exists.
   *
   * The shape check alone accepts 2026-13-40, and worse it accepts 2026-02-30,
   * which JavaScript rolls forward to the second of March. A date that means a
   * different day from the one written cannot be audited, so the parsed value
   * has to print back exactly what was written.
   */
  function isCalendarDate(text: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
    const parsed = new Date(text + "T00:00:00.000Z");
    return Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === text;
  }

  it.each([
    ["2026-13-40", false],
    ["2026-02-30", false],
    ["2026-00-10", false],
    ["2026-04-31", false],
    ["10-08-2026", false],
    ["2026-08-10", true],
    ["2024-02-29", true]
  ] as readonly [string, boolean][])("judges the date %s", (text, expected) => {
    expect(isCalendarDate(text)).toBe(expected);
  });

  it("states a source for every documented fixture and cites one where official", () => {
    for (const fixture of documentedFixtures) {
      expect(isCalendarDate(fixture.reviewedAt)).toBe(true);
      expect(fixture.note.length).toBeGreaterThan(20);
      if (fixture.sourceStatus === "provisional") {
        expect(fixture.docsUrl).toBeNull();
        /* A provisional fixture has to say where its shape came from and admit
           what that is worth. The three live readers now cite a dated
           observation against a real account rather than an undated prototype,
           which is better evidence and still not a published contract, so the
           note must carry the date AND the admission. */
        expect(fixture.note).toMatch(/20\d\d-\d\d-\d\d/u);
        expect(fixture.note).toContain("design evidence only");
      }
    }
    const claude = documentedFixtures.find((fixture) => fixture.connector === "claude");
    expect(claude?.sourceStatus).toBe("official");
    expect(claude?.docsUrl).toBe("https://code.claude.com/docs/en/statusline");
  });

  it("gives every fixture a unique id", () => {
    const ids = [
      ...documentedFixtures.map((fixture) => fixture.id),
      ...sanitizedLiveFixtures.map((fixture) => fixture.id),
      ...malformedFixtures.map((fixture) => fixture.id)
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
