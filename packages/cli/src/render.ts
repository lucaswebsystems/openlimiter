import {
  failureSentence,
  floorFixed,
  freshness,
  type FailureCategory,
  type ProviderFailure,
  type Snapshot,
  type SnapshotState
} from "@openlimiter/core";

/**
 * How the terminal draws a reading.
 *
 * This is the command line tool's presentation layer and nothing else lives
 * here. Every number arrives already decided by the engine; this module only
 * chooses a colour band, a bar, and a form of words.
 *
 * THE PRESSURE BANDS, AND WHY RED IS NOT WHERE THE ENGINE WARNS
 * -------------------------------------------------------------
 *   healthy   0 to 59        green
 *   watch     60 to 79       yellow
 *   urgent    80 to 89       orange, and yellow where there is no orange
 *   critical  90 and above   red
 *
 * Eighty is not a number this file picked. packages/core/src/policy.ts calls a
 * provider NEAR_CAP at 80 and stops recommending it there, so the orange band
 * opens at exactly the reading where the agent stops routing work to a
 * provider. The human and the agent change their mind about the same number at
 * the same instant, which is the point of the fourth band.
 *
 * The visual red at 90 is deliberately later than that agent warning. The agent
 * is told at 80 so it can route away while there is still room; the person
 * watching the bar sees red at 90, when the situation is actually worth
 * reacting to. Warning the agent earlier than the human sees red is the correct
 * direction, and collapsing the two would either make the display cry wolf or
 * make the routing act too late. Orange is what fills the gap between them.
 *
 * apps/web/app/app/language.ts and apps/desktop/ui/app.js carry their own copy
 * of these two functions, because none of the three can import from the others.
 * Those two still draw the earlier three band scale and have not been moved to
 * this one yet.
 */

/** The four bands, plus the band a meter with no reading gets. */
export type Pressure = "healthy" | "watch" | "urgent" | "critical" | "none";

export function pressureOf(percent: number): Pressure {
  if (!Number.isFinite(percent)) return "none";
  if (percent >= 90) return "critical";
  if (percent >= 80) return "urgent";
  if (percent >= 60) return "watch";
  return "healthy";
}

/** How many of the ten blocks a percentage lights, never rounding upward. */
export const BAR_SEGMENTS = 10;

/**
 * The statusline's own density.
 *
 * Five blocks, not ten. A statusline shares one row with a model name, a
 * branch, a directory and whatever else the host puts there, and six ten block
 * bars would take the row on their own. Half the blocks at twice the price per
 * block reads at a glance and still lands every reading in the right band,
 * which is all a status row is for. The snapshot table keeps all ten, because
 * a table is read deliberately and has the room.
 */
export const STATUSLINE_BAR_SEGMENTS = 5;

export function filledSegments(percent: number, segments = BAR_SEGMENTS): number {
  if (!Number.isFinite(percent)) return 0;
  if (!Number.isInteger(segments) || segments < 1) return 0;
  const bounded = Math.min(100, Math.max(0, percent));
  return Math.min(segments, Math.floor(bounded / (100 / segments)));
}

/* ------------------------------------------------------------------ colour */

const ESCAPE = "\u001b[";
const RESET = ESCAPE + "0m";

/**
 * The eight colour codes every terminal has had since the 1970s.
 *
 * There is no orange among them, which is the whole difficulty with a four band
 * scale: the band between yellow and red has no colour of its own to be drawn
 * in on a plain terminal.
 */
const BAND_CODE: Record<Pressure, string> = {
  healthy: "32",
  watch: "33",
  urgent: "33",
  critical: "31",
  none: "90"
};

/**
 * Orange, from the 256 colour cube, for the terminals that have one.
 *
 * `38;5;208` selects entry 208 of the extended palette, which is the orange
 * sitting between the yellow at 80 and the red at 90 rather than beside either.
 */
const ORANGE_256 = "38;5;208";

/** The one red every failure line is painted in. */
const RED = "31";

/**
 * Whether this run may emit escape codes.
 *
 * Two things veto colour, and either one is enough: the NO_COLOR convention,
 * which any value at all switches on, and standard output not being a
 * terminal, which is what a pipe into a file or another program looks like.
 */
export function supportsColor(
  environment: Readonly<Record<string, string | undefined>>,
  isTty: boolean
): boolean {
  if (environment["NO_COLOR"] !== undefined) return false;
  return isTty;
}

/**
 * Whether this terminal has more than the eight standard colours.
 *
 * Two signals, either one enough. A `TERM` naming `256color` is the convention
 * terminfo has used for decades, and a `COLORTERM` set to anything at all is
 * what the terminals that went further than 256 announce themselves with. Both
 * are claims the terminal makes about itself, not measurements, so this answers
 * a question about what may safely be emitted and never about what is true.
 *
 * A terminal that says neither is not an error and is not a lesser rendering.
 * It gets the yellow of the band below, so the reading still reads as pressure
 * and only the distinction between 80 and 60 is lost. Information degrades; it
 * never breaks, and no escape code is ever emitted that a terminal would print
 * as literal characters.
 */
export function supports256Color(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  const term = environment["TERM"];
  if (term !== undefined && term.includes("256color")) return true;
  return environment["COLORTERM"] !== undefined;
}

/**
 * The one place a band becomes a colour.
 *
 * Both the ten block table bar and the five block statusline bar come through
 * here, so a reading is the same colour wherever it is drawn, and the orange
 * fallback is decided once rather than at each call site.
 */
export function bandCode(band: Pressure, wide: boolean): string {
  if (band === "urgent" && wide) return ORANGE_256;
  return BAND_CODE[band];
}

function paint(text: string, code: string, color: boolean): string {
  return color ? ESCAPE + code + "m" + text + RESET : text;
}

/**
 * The segmented bar.
 *
 * Ten blocks by default, the same ten the dashboard and the desktop window
 * draw, and five when the statusline asks for its own density. With colour it
 * is drawn in block characters and painted in the band's colour. Without colour
 * it is the same positions in plain ASCII, because a terminal that reported no
 * colour support may also be a log file, and a log file should carry no escape
 * codes at all.
 *
 * The block count is the only thing the caller chooses. The band, and therefore
 * the colour, comes from the reading alone, so the same percentage is the same
 * colour at either density.
 *
 * `wide` is the terminal's own claim about its palette, and it defaults to the
 * answer read off the environment so every caller gets the right one without
 * carrying it. A test passes it explicitly, because a test that asks the
 * machine it happens to be running on what colours it has is not a test.
 */
export function meterBar(
  percent: number,
  state: SnapshotState,
  color: boolean,
  segments = BAR_SEGMENTS,
  wide = supports256Color(process.env)
): string {
  const known = state !== "unknown";
  const filled = known ? filledSegments(percent, segments) : 0;
  const empty = Math.max(0, segments - filled);
  const glyphs = color
    ? "█".repeat(filled) + "░".repeat(empty)
    : "#".repeat(filled) + ".".repeat(empty);
  const band: Pressure = known ? pressureOf(percent) : "none";
  return paint(glyphs, bandCode(band, wide), color);
}

/** A failure, in red, in our own fixed words. */
export function failureLine(
  provider: string,
  category: FailureCategory,
  color: boolean
): string {
  return paint(provider + " " + category + " " + failureSentence[category], RED, color);
}

export function failureLines(
  failures: readonly ProviderFailure[],
  color: boolean
): readonly string[] {
  return failures.map((failure) =>
    failureLine(failure.provider, failure.category, color));
}

/* ------------------------------------------------------------------ fields */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * Time left before the window resets, compact enough for a table column.
 *
 * Two units at most and no spaces, so every row stays one space separated
 * record that a script can still split. A window with no reset says so rather
 * than printing a zero.
 */
export function timeToReset(resetAt: string | null, now: string): string {
  if (resetAt === null) return "NONE";
  const target = Date.parse(resetAt);
  const current = Date.parse(now);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return "NONE";
  const remaining = target - current;
  if (remaining <= 0) return "PASSED";
  if (remaining < MINUTE) return "<1m";
  if (remaining < HOUR) return String(Math.floor(remaining / MINUTE)) + "m";
  if (remaining < DAY) {
    return String(Math.floor(remaining / HOUR)) + "h" +
      String(Math.floor((remaining % HOUR) / MINUTE)) + "m";
  }
  return String(Math.floor(remaining / DAY)) + "d" +
    String(Math.floor((remaining % DAY) / HOUR)) + "h";
}

/**
 * Money, when the reading carries it.
 *
 * The three fields travel together out of the normalizer, so checking one is
 * enough, and the currency is a closed literal rather than provider text.
 */
export function amountField(snapshot: Snapshot): string {
  const used = snapshot.usedAmount;
  const limit = snapshot.limitAmount;
  if (used === undefined || limit === undefined || snapshot.currency === undefined) {
    return "NONE";
  }
  return "$" + floorFixed(used, 2) + "/$" + floorFixed(limit, 2);
}

/* ------------------------------------------------------------------- table */

/**
 * The snapshot table.
 *
 * Eight columns, always eight, separated by one space. AMOUNT and RESET read
 * NONE where a provider has none rather than disappearing, because a table
 * whose column count moves with its data cannot be parsed by anything.
 */
export const TABLE_HEADER = "PROVIDER METER BAR USAGE AMOUNT STATE RESET IN";

export function renderTable(
  snapshots: readonly Snapshot[],
  now: string,
  color: boolean
): string {
  if (snapshots.length === 0) return "No bounded quota data is available.";
  const lines = [TABLE_HEADER];
  for (const snapshot of snapshots) {
    const state = freshness(snapshot.observedAt, snapshot.expiresAt, now);
    lines.push([
      snapshot.provider,
      snapshot.meter,
      meterBar(snapshot.value, state, color),
      floorFixed(snapshot.value, 2) + snapshot.unit,
      amountField(snapshot),
      state,
      snapshot.resetAt ?? "NONE",
      timeToReset(snapshot.resetAt, now)
    ].join(" "));
  }
  return lines.join("\n");
}
