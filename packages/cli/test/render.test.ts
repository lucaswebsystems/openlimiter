import { describe, expect, it } from "vitest";
import type { Snapshot } from "@openlimiter/core";
import {
  BAR_SEGMENTS,
  STATUSLINE_BAR_SEGMENTS,
  TABLE_HEADER,
  amountField,
  bandCode,
  failureLine,
  filledSegments,
  meterBar,
  pressureOf,
  renderTable,
  supports256Color,
  supportsColor,
  timeToReset
} from "../src/render.js";

/* The escape character, built from its code point so no control byte ever
   sits in this source file. */
const ESCAPE = String.fromCharCode(27);

const NOW = "2026-01-01T00:00:00.000Z";

function reading(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    provider: "OPENROUTER",
    meter: "CREDITS",
    value: 62.35,
    unit: "PERCENT",
    window: { kind: "lifetime" },
    resetAt: null,
    source: "documented_api",
    precision: "exact",
    observedAt: NOW,
    expiresAt: "2026-01-01T00:01:00.000Z",
    labels: {
      credentialOrigin: "user-key",
      dataInterfaceStatus: "documented-api",
      automationRisk: "low",
      verification: "UNVERIFIED"
    },
    ...overrides
  };
}

/**
 * The bands.
 *
 * Their exact edges are the whole point, so every boundary is pinned here
 * rather than sampled in the middle of a range. Fifty nine is still healthy and
 * sixty is not; seventy nine is watch and eighty is urgent; eighty nine is
 * urgent and ninety is critical.
 *
 * Eighty is the engine's own NEAR_CAP threshold, and it is now a boundary here
 * on purpose, so the orange a person sees and the warning an agent acts on
 * begin at the same reading. Ninety, where the bar turns red, is still later
 * than that, and that gap is asserted below because it is the design.
 */
describe("pressure bands", () => {
  it.each([
    [0, "healthy"],
    [42, "healthy"],
    [58, "healthy"],
    [59, "healthy"],
    [59.99, "healthy"],
    [60, "watch"],
    [64, "watch"],
    [79, "watch"],
    [79.99, "watch"],
    [80, "urgent"],
    [84, "urgent"],
    [89, "urgent"],
    [89.99, "urgent"],
    [90, "critical"],
    [92, "critical"],
    [100, "critical"]
  ])("puts %s in the %s band", (percent, band) => {
    expect(pressureOf(percent)).toBe(band);
  });

  it("opens the orange band at the engine's own NEAR_CAP threshold", () => {
    expect(pressureOf(79.99)).toBe("watch");
    expect(pressureOf(80)).toBe("urgent");
  });

  it("keeps the human red later than the agent warning at eighty", () => {
    expect(pressureOf(80)).toBe("urgent");
    expect(pressureOf(89)).toBe("urgent");
    expect(pressureOf(90)).toBe("critical");
  });

  it("has no band for a number that is not one", () => {
    expect(pressureOf(Number.NaN)).toBe("none");
    expect(pressureOf(Number.POSITIVE_INFINITY)).toBe("none");
  });
});

/**
 * The orange, and the terminals that have no orange.
 *
 * Eight colour terminals have no orange at all, so the urgent band borrows the
 * yellow of the band below rather than emitting a code the terminal would print
 * as text. Every other band is one code whatever the palette, because green,
 * yellow and red have been in every terminal since before any of this.
 */
describe("the fourth colour", () => {
  it("reads a 256 colour claim off TERM or COLORTERM", () => {
    expect(supports256Color({ TERM: "xterm-256color" })).toBe(true);
    expect(supports256Color({ TERM: "screen-256color" })).toBe(true);
    expect(supports256Color({ COLORTERM: "truecolor" })).toBe(true);
    expect(supports256Color({ COLORTERM: "" })).toBe(true);
    expect(supports256Color({ TERM: "dumb", COLORTERM: "24bit" })).toBe(true);
  });

  it("claims nothing for a terminal that claims nothing", () => {
    expect(supports256Color({})).toBe(false);
    expect(supports256Color({ TERM: "dumb" })).toBe(false);
    expect(supports256Color({ TERM: "xterm" })).toBe(false);
    expect(supports256Color({ TERM: "vt100" })).toBe(false);
  });

  it("paints the urgent band orange where there is an orange", () => {
    expect(bandCode("urgent", true)).toBe("38;5;208");
  });

  it("falls back to the yellow of the band below where there is not", () => {
    expect(bandCode("urgent", false)).toBe("33");
    expect(bandCode("urgent", false)).toBe(bandCode("watch", false));
  });

  it("leaves every other band on the same code at either palette", () => {
    for (const band of ["healthy", "watch", "critical", "none"] as const) {
      expect(bandCode(band, true)).toBe(bandCode(band, false));
    }
  });
});

describe("meter bar", () => {
  it.each([
    [0, 0],
    [9.9, 0],
    [10, 1],
    [42, 4],
    [62.35, 6],
    [92, 9],
    [99.99, 9],
    [100, 10]
  ])("lights %s percent as %s of ten blocks", (percent, filled) => {
    expect(filledSegments(percent)).toBe(filled);
  });

  it("never rounds a reading upward into a block it has not earned", () => {
    expect(filledSegments(89.99)).toBe(8);
    expect(filledSegments(90)).toBe(9);
  });

  it("draws ten positions whatever the reading", () => {
    for (const percent of [0, 33, 92, 100]) {
      expect(meterBar(percent, "fresh", false)).toHaveLength(BAR_SEGMENTS);
    }
  });

  it("draws an unknown reading as ten empty positions, never as a zero bar", () => {
    expect(meterBar(92, "unknown", false)).toBe(".".repeat(BAR_SEGMENTS));
  });

  it("paints all four band colours when colour and a palette are allowed", () => {
    expect(meterBar(42, "fresh", true, BAR_SEGMENTS, true)).toContain(ESCAPE + "[32m");
    expect(meterBar(64, "fresh", true, BAR_SEGMENTS, true)).toContain(ESCAPE + "[33m");
    expect(meterBar(84, "fresh", true, BAR_SEGMENTS, true))
      .toContain(ESCAPE + "[38;5;208m");
    expect(meterBar(92, "fresh", true, BAR_SEGMENTS, true)).toContain(ESCAPE + "[31m");
    expect(meterBar(42, "fresh", true, BAR_SEGMENTS, true)).toContain(ESCAPE + "[0m");
  });

  it("draws the urgent band in yellow on a terminal with no orange", () => {
    const plain = meterBar(84, "fresh", true, BAR_SEGMENTS, false);
    expect(plain).toContain(ESCAPE + "[33m");
    expect(plain).not.toContain("38;5;208");
    /* Same eight blocks either way. Only the colour degrades. */
    expect(plain).toContain("████████░░");
    expect(meterBar(84, "fresh", true, BAR_SEGMENTS, true)).toContain("████████░░");
  });

  it("emits no control character at all when colour is refused", () => {
    for (const percent of [42, 64, 84, 92]) {
      for (const wide of [true, false]) {
        expect(meterBar(percent, "fresh", false, BAR_SEGMENTS, wide))
          .not.toContain(ESCAPE);
      }
    }
    expect(meterBar(42, "fresh", false)).toBe("####......");
    expect(meterBar(84, "fresh", false)).toBe("########..");
  });
});

/**
 * The statusline density.
 *
 * Five blocks instead of ten, and nothing else changes: the same reading is
 * the same band and therefore the same colour at either density, and the
 * truncation rule still refuses to light a block the reading has not earned.
 */
describe("statusline bar", () => {
  it("draws five positions whatever the reading", () => {
    for (const percent of [0, 33, 92, 100]) {
      expect(meterBar(percent, "fresh", false, STATUSLINE_BAR_SEGMENTS))
        .toHaveLength(STATUSLINE_BAR_SEGMENTS);
    }
  });

  it.each([
    [0, 0],
    [19.9, 0],
    [20, 1],
    [42, 2],
    [62.35, 3],
    [92, 4],
    [99.99, 4],
    [100, 5]
  ])("lights %s percent as %s of five blocks", (percent, filled) => {
    expect(filledSegments(percent, STATUSLINE_BAR_SEGMENTS)).toBe(filled);
  });

  it("keeps the band, and therefore the colour, at either density", () => {
    for (const percent of [42, 64, 84, 92]) {
      for (const palette of [true, false]) {
        const ten = meterBar(percent, "fresh", true, BAR_SEGMENTS, palette);
        const five = meterBar(
          percent,
          "fresh",
          true,
          STATUSLINE_BAR_SEGMENTS,
          palette
        );
        /* The escape sequence runs up to the first block, whatever it is. */
        const code = (bar: string): string => bar.slice(0, bar.indexOf("m") + 1);
        expect(code(five)).toBe(code(ten));
      }
    }
  });

  it("draws an unknown reading as five empty positions", () => {
    expect(meterBar(92, "unknown", false, STATUSLINE_BAR_SEGMENTS)).toBe(".....");
  });
});

describe("colour support", () => {
  it("follows the terminal when nothing objects", () => {
    expect(supportsColor({}, true)).toBe(true);
    expect(supportsColor({}, false)).toBe(false);
  });

  it("obeys NO_COLOR whatever its value, including empty", () => {
    expect(supportsColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(supportsColor({ NO_COLOR: "" }, true)).toBe(false);
    expect(supportsColor({ NO_COLOR: "0" }, true)).toBe(false);
  });
});

describe("fields", () => {
  it("prints money only when the reading carries all of it", () => {
    expect(amountField(reading({
      usedAmount: 12.47,
      limitAmount: 20,
      currency: "USD"
    }))).toBe("$12.47/$20.00");
    expect(amountField(reading())).toBe("NONE");
    expect(amountField(reading({ usedAmount: 12.47 }))).toBe("NONE");
  });

  it("never rounds a spend upward", () => {
    expect(amountField(reading({
      usedAmount: 12.479,
      limitAmount: 20,
      currency: "USD"
    }))).toBe("$12.47/$20.00");
  });

  it("states the time left without a space, so a row stays parseable", () => {
    expect(timeToReset("2026-01-01T05:00:00.000Z", NOW)).toBe("5h0m");
    expect(timeToReset("2026-01-01T00:30:00.000Z", NOW)).toBe("30m");
    expect(timeToReset("2026-01-08T00:00:00.000Z", NOW)).toBe("7d0h");
    expect(timeToReset("2026-01-01T00:00:30.000Z", NOW)).toBe("<1m");
    expect(timeToReset("2025-01-01T00:00:00.000Z", NOW)).toBe("PASSED");
    expect(timeToReset(null, NOW)).toBe("NONE");
    expect(timeToReset("not an instant", NOW)).toBe("NONE");
    for (const target of [
      "2026-01-01T05:00:00.000Z",
      "2026-01-08T00:00:00.000Z",
      "2026-01-01T00:30:00.000Z"
    ]) {
      expect(timeToReset(target, NOW)).not.toContain(" ");
    }
  });
});

describe("table", () => {
  it("keeps nine columns on every row so a script can split it", () => {
    const table = renderTable(
      [
        reading({ usedAmount: 12.47, limitAmount: 20, currency: "USD" }),
        reading({
          provider: "CLAUDE",
          meter: "FIVE_HOUR",
          value: 42,
          resetAt: "2026-01-01T05:00:00.000Z"
        })
      ],
      NOW,
      false
    );
    const lines = table.split("\n");
    /* The unpadded TABLE_HEADER carries nine column names, one per source field. */
    expect(TABLE_HEADER.split(" ")).toHaveLength(9);
    /* The padded header, split by whitespace, gives the same nine names. */
    const headerTokens = lines[0]!.trim().split(/\s+/);
    expect(headerTokens).toEqual(["PROVIDER", "METER", "BAR", "USAGE", "AMOUNT", "STATE", "RESET", "IN", "SOURCE"]);
    /* Every data row carries a bar, an exact percent, and a reset indicator. */
    for (const line of lines.slice(1)) {
      const tokens = line.split(/\s+/);
      expect(tokens.length).toBeGreaterThanOrEqual(9);
      expect(tokens[2]).toHaveLength(10);
      expect(tokens[3]).toMatch(/^\d+\.\d\d(PERCENT|TOKENS|REQUESTS)/);
      expect(tokens[7]).not.toBe("");
    }
  });

  it("shows the percent and the time to reset on every row", () => {
    const table = renderTable(
      [reading({
        provider: "CLAUDE",
        meter: "FIVE_HOUR",
        value: 42,
        resetAt: "2026-01-01T05:00:00.000Z"
      })],
      NOW,
      false
    );
    expect(table).toContain("42.00PERCENT");
    expect(table).toContain("5h0m");
  });

  it("sorts fresh pressure first and all unknown providers last by name", () => {
    const table = renderTable(
      [
        reading({
          provider: "CODEX",
          value: 99,
          observedAt: "2025-12-31T00:00:00.000Z",
          expiresAt: "2025-12-31T01:00:00.000Z"
        }),
        reading({ provider: "CLAUDE", value: 80 }),
        reading({
          provider: "OPENROUTER",
          value: 100,
          observedAt: "not an instant"
        }),
        reading({
          provider: "ANTIGRAVITY",
          value: 1,
          observedAt: "not an instant"
        })
      ],
      NOW,
      false
    );
    const providers = table.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0]);
    expect(providers).toEqual(["CLAUDE", "CODEX", "ANTIGRAVITY", "OPENROUTER"]);
  });

  it("says so plainly when there is nothing to show", () => {
    expect(renderTable([], NOW, false)).toBe("No bounded quota data is available.");
  });
});

describe("failure lines", () => {
  it("prints our own sentence in red, never the provider's words", () => {
    const line = failureLine("OPENROUTER", "VALIDATION_REJECTED", true);
    expect(line).toContain(ESCAPE + "[31m");
    expect(line).toContain(ESCAPE + "[0m");
    expect(line).toContain("OPENROUTER");
    expect(line).toContain("Payload failed validation, kept the last good reading.");
  });

  it("drops the colour without dropping the sentence", () => {
    const line = failureLine("CLAUDE", "SESSION_EXPIRED", false);
    expect(line).not.toContain(ESCAPE);
    expect(line).toBe("CLAUDE SESSION_EXPIRED Session expired.");
  });
});
