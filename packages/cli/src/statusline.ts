import {
  PROVIDER_CODES,
  floorFixed,
  freshness,
  type Advice,
  type ProviderCode,
  type Snapshot
} from "@openlimiter/core";
import { STATUSLINE_BAR_SEGMENTS, meterBar } from "./render.js";
import type { StatuslineColor, StatuslineConfig } from "./config.js";

/**
 * Statusline layout, version two.
 *
 * Version one was one plain line of provider names and percentages, and every
 * person who wanted to see pressure at a glance ended up drawing their own bar
 * around it. This module draws it instead: one compact cell per provider,
 * `NAME bar percent`, with the overall reason code leading the row, and a
 * second row when the first one runs out of columns.
 *
 * The old line is still here. `bars false` returns it byte for byte through the
 * adapter that has always produced it, because a format somebody wrote a script
 * against is a promise, and the way to change a promise is to leave the old one
 * reachable.
 *
 * Nothing in this file decides a number. Percentages, freshness, the reason
 * code and the recommendation all arrive already decided by the engine; this is
 * ordering, measuring and wrapping.
 */

/**
 * Which half of the row a provider belongs in.
 *
 * A subscription is a window that refills on a clock, so its percentage is
 * about how much of today is left. A credit or API balance is money, so its
 * percentage is about how much of the plan is left forever. Reading the two
 * kinds in one undifferentiated row invites treating a spent balance like a
 * window that will come back, so the subscriptions come first and the priced
 * meters sit at the end where they read as a different kind of fact.
 *
 * The table is exhaustive over the provider codes on purpose: a provider added
 * to the engine will not compile until somebody says which half it is in.
 */
const PROVIDER_CLASS: Record<ProviderCode, "subscription" | "api"> = {
  CLAUDE: "subscription",
  CODEX: "subscription",
  ANTIGRAVITY: "subscription",
  OPENCODE: "subscription",
  MANUAL: "subscription",
  OPENROUTER: "api"
};

export const DEFAULT_PROVIDER_ORDER: readonly ProviderCode[] = [
  ...PROVIDER_CODES.filter((code) => PROVIDER_CLASS[code] === "subscription"),
  ...PROVIDER_CODES.filter((code) => PROVIDER_CLASS[code] === "api")
];

const providerCodes = new Set<string>(PROVIDER_CODES);

/**
 * The order the configured ids ask for, completed by the built in order.
 *
 * An id this version does not know, and an id named twice, are both dropped
 * rather than rejected. This runs on every redraw of somebody else's status
 * row; a stale provider id left in a configuration file is not a reason to
 * stop drawing the providers that are still there.
 */
export function resolveProviderOrder(
  configured: readonly string[]
): readonly ProviderCode[] {
  const listed: ProviderCode[] = [];
  for (const id of configured) {
    const code = id.toUpperCase();
    if (!providerCodes.has(code)) continue;
    const provider = code as ProviderCode;
    if (listed.includes(provider)) continue;
    listed.push(provider);
  }
  return [
    ...listed,
    ...DEFAULT_PROVIDER_ORDER.filter((code) => !listed.includes(code))
  ];
}

/* ------------------------------------------------------------------ meters */

export type MeterClass =
  | "session"
  | "daily"
  | "weekly"
  | "monthly"
  | "credits"
  | "other";

/** Shortest window first, then money, then anything unrecognised. */
const METER_CLASS_RANK: Record<MeterClass, number> = {
  session: 0,
  daily: 1,
  weekly: 2,
  monthly: 3,
  credits: 4,
  other: 5
};

const SIX_HOURS = 21_600;
const ONE_DAY = 86_400;
const SEVEN_DAYS = 604_800;
const THIRTY_ONE_DAYS = 2_678_400;

/**
 * The classes a meter name maps to when its window states no duration.
 *
 * Only names this project already emits, plus the obvious synonyms a hand
 * written manual document reaches for. Anything else is `other` and sorts
 * last, which is the honest answer: an unrecognised name is not evidence of a
 * short window.
 */
const METER_NAME_CLASS: Readonly<Record<string, MeterClass>> = {
  SESSION: "session",
  PRIMARY: "session",
  FIVE_HOUR: "session",
  HOURLY: "session",
  DAILY: "daily",
  DAY: "daily",
  WEEKLY: "weekly",
  WEEK: "weekly",
  SEVEN_DAY: "weekly",
  MONTHLY: "monthly",
  MONTH: "monthly",
  CREDITS: "credits",
  BALANCE: "credits"
};

/**
 * Which kind of window a reading measures.
 *
 * The window's own duration decides it wherever a connector states one,
 * because a duration is a fact and a name is a label. The name table is the
 * fallback for the connectors that state a window kind and no length.
 */
export function meterClass(snapshot: Snapshot): MeterClass {
  if (snapshot.unit === "CREDITS" || snapshot.window.kind === "lifetime") {
    return "credits";
  }
  const duration = snapshot.window.durationSeconds;
  if (duration !== undefined) {
    if (duration <= SIX_HOURS) return "session";
    if (duration <= ONE_DAY) return "daily";
    if (duration <= SEVEN_DAYS) return "weekly";
    if (duration <= THIRTY_ONE_DAYS) return "monthly";
    return "other";
  }
  return METER_NAME_CLASS[snapshot.meter] ?? "other";
}

/* ------------------------------------------------------------------- cells */

export interface StatuslineCell {
  /** The cell with no escape codes, which is what the width budget measures. */
  readonly plain: string;
  /** The cell as printed, painted when colour is allowed. */
  readonly painted: string;
  /** The reading behind it, which decides what survives when cells are shed. */
  readonly percent: number;
}

/** Two spaces between cells, so a reader can tell one cell from the next. */
export const CELL_GAP = "  ";

function buildCell(
  label: string,
  snapshot: Snapshot,
  state: "fresh" | "stale",
  color: boolean,
  wide?: boolean
): StatuslineCell {
  const percent = floorFixed(snapshot.value, 1) + "%";
  const bar = (paint: boolean): string =>
    meterBar(snapshot.value, state, paint, STATUSLINE_BAR_SEGMENTS, wide);
  return {
    plain: label + " " + bar(false) + " " + percent,
    painted: label + " " + bar(color) + " " + percent,
    percent: snapshot.value
  };
}

interface Reading {
  snapshot: Snapshot;
  state: "fresh" | "stale";
}

function readingsFor(
  snapshots: readonly Snapshot[],
  provider: ProviderCode,
  now: string
): Reading[] {
  return snapshots
    .filter((snapshot) => snapshot.provider === provider && snapshot.unit === "PERCENT")
    .map((snapshot) => ({
      snapshot,
      state: freshness(snapshot.observedAt, snapshot.expiresAt, now)
    }))
    .filter((reading): reading is Reading => reading.state !== "unknown")
    .sort((left, right) => {
      const rank = METER_CLASS_RANK[meterClass(left.snapshot)] -
        METER_CLASS_RANK[meterClass(right.snapshot)];
      if (rank !== 0) return rank;
      return left.snapshot.meter < right.snapshot.meter ? -1 : 1;
    });
}

/**
 * One cell per provider, or one per meter.
 *
 * The filter is the same one the advice policy uses, so the cells and the
 * reason code leading them are always describing the same set of readings. A
 * provider with several meters shows its worst one, because a status row exists
 * to tell you what is about to stop you, and the meter closest to its cap is
 * that. The full set is one `openlimiter snapshot` away, and `meters all` puts
 * it back in the row for anyone who wants it there.
 *
 * `wide` is the terminal's 256 colour claim, handed straight to the shared bar
 * so a statusline cell and a table row draw the same reading in the same band
 * colour. Left off, the bar reads the environment for itself.
 */
export function statuslineCells(
  snapshots: readonly Snapshot[],
  now: string,
  order: readonly ProviderCode[],
  meters: StatuslineConfig["meters"],
  color: boolean,
  wide?: boolean
): readonly StatuslineCell[] {
  const cells: StatuslineCell[] = [];
  for (const provider of order) {
    const readings = readingsFor(snapshots, provider, now);
    if (readings.length === 0) continue;
    if (meters === "all") {
      for (const reading of readings) {
        cells.push(buildCell(
          provider + ":" + reading.snapshot.meter,
          reading.snapshot,
          reading.state,
          color,
          wide
        ));
      }
      continue;
    }
    let worst = readings[0]!;
    for (const reading of readings.slice(1)) {
      if (reading.snapshot.value > worst.snapshot.value) worst = reading;
    }
    cells.push(buildCell(provider, worst.snapshot, worst.state, color, wide));
  }
  return cells;
}

/* ------------------------------------------------------------------ layout */

/**
 * Everything that is not a cell.
 *
 * The reason code, the recommendation and the unknown list are the same three
 * fields the 0.1.0 line carried and they carry the same words, moved to the
 * front so that the row can end wherever the cells end. They are never wrapped
 * and never dropped: a row of bars with no verdict in front of it is a picture,
 * not a status.
 */
export function statuslineHead(advice: Advice): string {
  const recommendation = advice.recommendation.code === "PREFER"
    ? " PREFER " + advice.recommendation.provider
    : " NONE";
  const unknown = advice.unknownProviders.length === 0
    ? ""
    : " UNKNOWN " + advice.unknownProviders.join(",");
  return "OpenLimiter " + advice.reason + recommendation + unknown;
}

function moreCell(dropped: number): StatuslineCell {
  const text = "+" + String(dropped) + " more";
  return { plain: text, painted: text, percent: Number.NEGATIVE_INFINITY };
}

/**
 * Fill the rows left to right and report where it got to.
 *
 * A cell is placed whole or not at all, so the break always lands between two
 * cells. Nothing is ever cut in half, because half a bar reads as a reading and
 * is not one.
 */
function packed(
  head: string,
  cells: readonly StatuslineCell[],
  width: number,
  rows: number
): StatuslineCell[][] {
  const laid: StatuslineCell[][] = [];
  let index = 0;
  for (let row = 0; row < rows; row += 1) {
    const current: StatuslineCell[] = [];
    let used = row === 0 ? head.length : 0;
    while (index < cells.length) {
      const cell = cells[index]!;
      const needed = used === 0
        ? cell.plain.length
        : used + CELL_GAP.length + cell.plain.length;
      if (needed > width) break;
      used = needed;
      current.push(cell);
      index += 1;
    }
    laid.push(current);
  }
  return laid;
}

function fittedCount(rows: readonly StatuslineCell[][]): number {
  return rows.reduce((total, row) => total + row.length, 0);
}

/**
 * The worst cells, restored to display order.
 *
 * When the row cannot hold everything, what it drops has to be the readings
 * that matter least, and the reading that matters least is the one furthest
 * from its cap. Ties keep display order, so the choice is stable between
 * redraws of the same data.
 */
function worstCells(
  cells: readonly StatuslineCell[],
  keep: number
): StatuslineCell[] {
  return cells
    .map((cell, index) => ({ cell, index }))
    .sort((left, right) =>
      right.cell.percent - left.cell.percent || left.index - right.index)
    .slice(0, keep)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.cell);
}

function paintRows(head: string, rows: readonly StatuslineCell[][]): string {
  const lines: string[] = [];
  rows.forEach((row, index) => {
    const body = row.map((cell) => cell.painted).join(CELL_GAP);
    if (index === 0) {
      lines.push(body === "" ? head : head + CELL_GAP + body);
      return;
    }
    if (body !== "") lines.push(body);
  });
  return lines.join("\n");
}

export interface StatuslineLayoutInput {
  advice: Advice;
  snapshots: readonly Snapshot[];
  now: string;
  config: StatuslineConfig;
  color: boolean;
  /**
   * Whether the host terminal claims a 256 colour palette.
   *
   * Only the orange band at 80 depends on it, and only a test ever states it.
   * Left off, the bar asks the environment, which is the right answer for every
   * caller that is a real terminal or a statusline host standing in for one.
   */
  wide?: boolean;
}

/** What the statusline says when it has nothing bounded to say. */
export const STATUSLINE_UNKNOWN = "OpenLimiter UNKNOWN";

/**
 * Draw the whole line, stacking it rather than truncating it.
 *
 * The budget is a budget, not a terminal measurement: nothing here asks the
 * operating system how wide the window is, because a statusline host runs this
 * command with no terminal attached and the answer would be an invention. The
 * number in the configuration is the number that is honoured.
 */
export function renderStatuslineLayout(input: StatuslineLayoutInput): string {
  const { advice, config } = input;
  if (!advice.inject || advice.reason === "UNKNOWN") return STATUSLINE_UNKNOWN;
  const cells = statuslineCells(
    input.snapshots,
    input.now,
    resolveProviderOrder(config.order),
    config.meters,
    input.color,
    input.wide
  );
  if (cells.length === 0) return STATUSLINE_UNKNOWN;
  const head = statuslineHead(advice);
  const whole = packed(head, cells, config.width, config.rows);
  if (fittedCount(whole) === cells.length) return paintRows(head, whole);
  /*
   * Something has to go. Give up one cell at a time, worst kept first, until
   * what is left plus the count of what was dropped fits inside the rows. The
   * search starts at the number that already fitted, which is an upper bound,
   * and it is bounded below by zero, which is the row with only a head on it.
   */
  for (let keep = fittedCount(whole); keep >= 0; keep -= 1) {
    const shown = [...worstCells(cells, keep), moreCell(cells.length - keep)];
    const attempt = packed(head, shown, config.width, config.rows);
    if (fittedCount(attempt) === shown.length) return paintRows(head, attempt);
  }
  return head;
}

/**
 * Whether this render may paint.
 *
 * `NO_COLOR` wins over every setting, including `always`. It is the one
 * convention a person can set once, for every tool on the machine, and a
 * configuration file inside one tool is not the place to overrule it.
 */
export function statuslineColor(
  setting: StatuslineColor,
  environment: Readonly<Record<string, string | undefined>>,
  automatic: boolean
): boolean {
  if (environment["NO_COLOR"] !== undefined) return false;
  if (setting === "never") return false;
  if (setting === "always") return true;
  return automatic;
}
