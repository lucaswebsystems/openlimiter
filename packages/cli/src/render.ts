import {
  collectionIdentity,
  failureSentence,
  floorFixed,
  freshness,
  type FailureCategory,
  type ProviderFailure,
  type Snapshot,
  type SnapshotProvenance,
  type SnapshotState
} from "@openlimiter/core";

/**
 * How the terminal draws a reading.
 *
 * This is the command line tool's presentation layer and nothing else lives
 * here. Every number arrives already decided by the engine; this module only
 * chooses a colour band, a bar, a source chip, and a form of words.
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
 * Whether this terminal can draw the eighth block glyphs used for sub character
 * bar resolution.
 *
 * Three things veto it, and any one is enough: the NO_COLOR convention, a
 * stream that is not a terminal, and a platform whose default console draws box
 * characters as empty rectangles. A fallback to plain ASCII blocks keeps the
 * output readable on the platforms that need it.
 */
export function supportsEighthBlocks(
  environment: Readonly<Record<string, string | undefined>>,
  isTty: boolean,
  platform: string
): boolean {
  if (environment["NO_COLOR"] !== undefined) return false;
  if (!isTty) return false;
  if (platform === "win32" && environment["WT_SESSION"] === undefined) return false;
  return true;
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

/** The eighth block glyphs, from one eighth to seven eighths. */
const EIGHTH_GLYPHS = ["", "\u258f", "\u258e", "\u258d", "\u258c", "\u258b", "\u258a", "\u2589"];

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
 * The table bar also gains sub character resolution when the terminal can draw
 * the eighth block glyphs, so readings that differ by a few percent no longer
 * share the same bar. A terminal that cannot draw them falls back to the whole
 * block rendering, exactly as before.
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
  wide = supports256Color(process.env),
  eighthBlocks = supportsEighthBlocks(
    process.env,
    process.stdout.isTTY === true,
    process.platform
  )
): string {
  const known = state !== "unknown";
  const band: Pressure = known ? pressureOf(percent) : "none";

  if (segments === BAR_SEGMENTS && known && eighthBlocks) {
    const bounded = Math.min(100, Math.max(0, percent));
    const totalEighths = Math.round((bounded / 100) * segments * 8);
    const full = Math.floor(totalEighths / 8);
    const remainder = totalEighths % 8;
    const empty = Math.max(0, segments - full - (remainder > 0 ? 1 : 0));
    const glyphs = "\u2588".repeat(full) +
      (remainder > 0 ? EIGHTH_GLYPHS[remainder] : "") +
      "\u2591".repeat(empty);
    return paint(glyphs, bandCode(band, wide), color);
  }

  const filled = known ? filledSegments(percent, segments) : 0;
  const empty = Math.max(0, segments - filled);
  const glyphs = color
    ? "\u2588".repeat(filled) + "\u2591".repeat(empty)
    : "#".repeat(filled) + ".".repeat(empty);
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

/** The column order and the header labels that sit above them. */
const COLUMNS: { readonly key: keyof Row; readonly header: string }[] = [
  { key: "provider", header: "PROVIDER" },
  { key: "meter", header: "METER" },
  { key: "bar", header: "BAR" },
  { key: "usage", header: "USAGE" },
  { key: "amount", header: "AMOUNT" },
  { key: "state", header: "STATE" },
  { key: "reset", header: "RESET" },
  { key: "remaining", header: "IN" },
  { key: "chip", header: "SOURCE" }
];

export const TABLE_HEADER = COLUMNS.map((column) => column.header).join(" ");

/** How wide the provider identity may grow before it is truncated. */
const MAX_PROVIDER_WIDTH = 13;

/** The one ellipsis, kept as a single character so truncation costs one cell. */
const ELLIPSIS = "\u2026";

interface Row {
  provider: string;
  meter: string;
  bar: string;
  usage: string;
  amount: string;
  state: string;
  reset: string;
  remaining: string;
  chip: string;
}

/** The provider identity, with its account when one is present. */
function providerIdentity(snapshot: Snapshot): string {
  return collectionIdentity(snapshot.provider, snapshot.accountId);
}

/** Trim an identity to the column width, keeping the leftmost characters. */
function truncateIdentity(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, Math.max(0, maxWidth - 1)) + ELLIPSIS;
}

/**
 * Map a snapshot's provenance to a connection state based source chip.
 *
 * The vocabulary is the one in packages/core/src/connection-state.ts, because
 * a parser is not a connection and only the product's own lifecycle words may
 * describe where a reading came from.
 */
function provenanceConnectionState(provenance: SnapshotProvenance | undefined): string {
  if (provenance === undefined) return "NOT_CONFIGURED";
  if (provenance.sourceKind === "statusline_payload") return "CONNECTED";
  if (provenance.sourceKind === "explicit_ingest") return "IMPORT_ONLY";
  if (provenance.sourceKind === "manual_document") return "MANUAL";
  if (provenance.sourceKind === "remote_api") return "CONNECTED";
  return "ERROR";
}

/** One short bracket chip describing the snapshot's source. */
function provenanceChip(provenance: SnapshotProvenance | undefined): string {
  if (
    provenance?.sourceKind === "statusline_payload" &&
    provenance.observedVia === "claude_code_statusline"
  ) {
    return "[local cli]";
  }
  const state = provenanceConnectionState(provenance);
  const label = state === "IMPORT_ONLY"
    ? "import only"
    : state.replace(/_/gu, " ").toLowerCase();
  return "[" + label + "]";
}

function buildRow(snapshot: Snapshot, now: string, color: boolean): Row {
  const state = freshness(snapshot.observedAt, snapshot.expiresAt, now);
  return {
    provider: truncateIdentity(providerIdentity(snapshot), MAX_PROVIDER_WIDTH),
    meter: snapshot.meter,
    bar: meterBar(snapshot.value, state, color),
    usage: floorFixed(snapshot.value, 2) + snapshot.unit,
    amount: amountField(snapshot),
    state,
    reset: snapshot.resetAt ?? "NONE",
    remaining: timeToReset(snapshot.resetAt, now),
    chip: provenanceChip(snapshot.provenance)
  };
}

/** The visible width of a field, which differs from its string length for bars. */
function visibleWidth(key: keyof Row, value: string): number {
  if (key === "bar") return BAR_SEGMENTS;
  return value.length;
}

/** Render rows with every column padded to its widest value so lines align. */
function renderRows(rows: readonly Row[]): string {
  const widths: Record<keyof Row, number> = {} as Record<keyof Row, number>;
  for (const column of COLUMNS) {
    widths[column.key] = Math.max(
      column.header.length,
      ...rows.map((row) => visibleWidth(column.key, row[column.key]))
    );
  }
  const header = COLUMNS
    .map((column) => column.header.padEnd(widths[column.key]))
    .join(" ");
  const lines = [header];
  for (const row of rows) {
    lines.push(COLUMNS
      .map((column) => row[column.key].padEnd(widths[column.key]))
      .join(" "));
  }
  return lines.join("\n");
}

/**
 * Sort providers by their most constrained meter, then keep each provider's
 * rows together so a person reads one account at a time.
 */
function orderSnapshots(
  snapshots: readonly Snapshot[]
): Snapshot[] {
  const grouped = new Map<string, Snapshot[]>();
  for (const snapshot of snapshots) {
    const group = grouped.get(snapshot.provider) ?? [];
    group.push(snapshot);
    grouped.set(snapshot.provider, group);
  }
  const ordered = [...grouped.entries()].sort((left, right) => {
    const leftMax = Math.max(...left[1].map((snapshot) => snapshot.value));
    const rightMax = Math.max(...right[1].map((snapshot) => snapshot.value));
    if (rightMax !== leftMax) return rightMax - leftMax;
    return left[0].localeCompare(right[0]);
  });
  const result: Snapshot[] = [];
  for (const [, group] of ordered) {
    result.push(...[...group].sort((left, right) => {
      if (right.value !== left.value) return right.value - left.value;
      return left.meter.localeCompare(right.meter);
    }));
  }
  return result;
}

export function renderTable(
  snapshots: readonly Snapshot[],
  now: string,
  color: boolean
): string {
  if (snapshots.length === 0) return "No bounded quota data is available.";
  const rows = orderSnapshots(snapshots).map((snapshot) =>
    buildRow(snapshot, now, color));
  return renderRows(rows);
}
