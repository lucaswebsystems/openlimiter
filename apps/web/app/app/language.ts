import { floorFixed, type Advice, type MeterView, type ProviderCode, type SnapshotState } from "./engine";

/** The engine's four overall reason codes. */
type AdviceReason = Advice["reason"];

/**
 * The words and the thresholds the dashboard renders with.
 *
 * Nothing here decides anything about quota. Every number that matters is
 * already decided by the engine; this module only chooses which colour band a
 * decided number falls in, and which English sentence a decided enum code is
 * shown as. The desktop window carries the same three functions in plain
 * JavaScript, so the two surfaces cannot describe one reading differently.
 */

/** The four pressure bands, plus the band a meter with no reading gets. */
export type Pressure = "ok" | "watch" | "high" | "critical" | "none";

/**
 * The band a percentage falls in.
 *
 *   ok        0 to 59
 *   watch     60 to 79
 *   high      80 to 89
 *   critical  90 and above
 *
 * EIGHTY IS THE ENGINE'S OWN NUMBER. packages/core/src/policy.ts calls a
 * provider NEAR_CAP at 80 and stops recommending it there, so a meter turning
 * orange is the same event as the agent being told to route away: the human
 * and the agent see the same threshold at the same moment. Red at 90 is the
 * human's own band on top of that, the point at which it is worth acting
 * rather than merely knowing.
 *
 * Nothing here feeds back into the engine. No number, no reason code and no
 * recommendation is derived from these bands: they choose a colour and stop.
 * The desktop window and the command line tool carry the same four.
 */
export function pressureOf(percent: number): Pressure {
  if (!Number.isFinite(percent)) return "none";
  if (percent >= 90) return "critical";
  if (percent >= 80) return "high";
  if (percent >= 60) return "watch";
  return "ok";
}

/** How many of the ten blocks are full, and whether the next one is half. */
export function blocks(percent: number): readonly ("full" | "half" | "empty")[] {
  const bounded = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return Array.from({ length: 10 }, (_unused, index) => {
    const floor = index * 10;
    if (bounded >= floor + 10) return "full";
    if (bounded >= floor + 5) return "half";
    return "empty";
  });
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * A reset window in the words a person would use.
 *
 * Two units at most, largest first, because "resets in 6d 23h" is something
 * you can plan around and "resets in 6d 23h 14m 09s" is a stopwatch.
 */
export function countdown(resetAt: string | null, now: string): string {
  if (resetAt === null) return "no reset window";
  const target = Date.parse(resetAt);
  const current = Date.parse(now);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return "no reset window";
  const remaining = target - current;
  if (remaining <= 0) return "reset window has passed";
  if (remaining < MINUTE) return "resets in under a minute";
  if (remaining < HOUR) {
    return "resets in " + String(Math.floor(remaining / MINUTE)) + "m";
  }
  if (remaining < DAY) {
    const hours = Math.floor(remaining / HOUR);
    const minutes = Math.floor((remaining % HOUR) / MINUTE);
    return "resets in " + String(hours) + "h " + String(minutes) + "m";
  }
  const days = Math.floor(remaining / DAY);
  const hours = Math.floor((remaining % DAY) / HOUR);
  return "resets in " + String(days) + "d " + String(hours) + "h";
}

/** What a freshness state means, in one short phrase. */
export const freshnessWord: Record<SnapshotState, string> = {
  fresh: "Fresh",
  stale: "Stale",
  unknown: "Unknown",
};

/**
 * A meter code, in the words a person uses for that stretch of time.
 *
 * The engine names a window after the thing it is: FIVE_HOUR is the rolling
 * window a session burns through, SEVEN_DAY is the week. Those are the right
 * names in a payload and the wrong ones on a card, so this is the one place
 * they are translated, and every surface reads from it.
 *
 * A provider may report a meter nobody here has heard of, because a manual
 * document names its own, so an unmapped code is never dropped and never left
 * shouting in upper case: it is title cased and shown as it is.
 */
const METER_NAMES: Record<string, string> = {
  FIVE_HOUR: "Current session",
  SESSION: "Current session",
  PRIMARY: "Primary window",
  SECONDARY: "Secondary window",
  HOURLY: "Hourly",
  DAILY: "Daily",
  ONE_DAY: "Daily",
  SEVEN_DAY: "Weekly",
  WEEKLY: "Weekly",
  THIRTY_DAY: "Monthly",
  MONTHLY: "Monthly",
  CREDITS: "Credits",
  BALANCE: "Credits",
};

export function meterName(code: string): string {
  const known = METER_NAMES[code];
  if (known !== undefined) return known;
  const words = code.toLowerCase().split(/[\s_-]+/u).filter((word) => word !== "");
  if (words.length === 0) return code;
  return words
    .map((word, index) =>
      index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    )
    .join(" ");
}

/**
 * Where a meter sits in the reading order.
 *
 * Shortest window first, money last, which is the order somebody actually
 * checks: what is left in this session, then today, then the week, then the
 * month, then the balance. Nothing here depends on how many meters a provider
 * reports, so a provider that grows a third window slots into the same order
 * with no change to any surface.
 */
const METER_RANK: Record<string, number> = {
  FIVE_HOUR: 10,
  SESSION: 10,
  PRIMARY: 15,
  SECONDARY: 16,
  HOURLY: 20,
  DAILY: 30,
  ONE_DAY: 30,
  SEVEN_DAY: 40,
  WEEKLY: 40,
  THIRTY_DAY: 50,
  MONTHLY: 50,
  CREDITS: 60,
  BALANCE: 60,
};

/** Unmapped codes sort after every known one, then alphabetically. */
export function meterRank(code: string): number {
  return METER_RANK[code] ?? 90;
}

/** Sort any list of meters into the reading order above, by code. */
export function byMeterOrder(left: string, right: string): number {
  const difference = meterRank(left) - meterRank(right);
  return difference !== 0 ? difference : left.localeCompare(right);
}

/**
 * How many meters a card is showing, when that is worth saying.
 *
 * One meter is the ordinary case and stating it is filler, so a card with one
 * meter says nothing at all. This returns null there and the caller renders
 * nothing rather than an empty chip.
 */
export function meterCountLabel(count: number): string | null {
  return count < 2 ? null : String(count) + " meters";
}

/** The plain sentence under an overall state chip. */
export const reasonSentence: Record<AdviceReason, string> = {
  HEALTHY: "Every readable meter is under 80%.",
  NEAR_CAP: "At least one readable meter is at 80% or more.",
  AT_CAP: "At least one readable meter has reached its cap.",
  UNKNOWN: "Nothing readable has been supplied yet.",
};

/**
 * The band an overall reason code is painted in.
 *
 * NEAR_CAP is orange rather than red now that the two scales agree on eighty:
 * the engine raises NEAR_CAP at exactly the percentage a meter turns orange, so
 * the chip and the bars say the same thing. AT_CAP keeps red, which is the one
 * state that means stop.
 */
export const reasonPressure: Record<AdviceReason, Pressure> = {
  HEALTHY: "ok",
  NEAR_CAP: "high",
  AT_CAP: "critical",
  UNKNOWN: "none",
};

/** Why there is no provider to prefer, when there is none. */
export const noRecommendationSentence: Record<string, string> = {
  NO_KNOWN_PROVIDER: "No provider has a readable meter.",
  NO_FRESH_DATA: "Every reading has aged past its own expiry.",
  NO_HEALTHY_PROVIDER: "Every readable provider is at 80% or more.",
};

const PROVIDER_NAMES: Record<ProviderCode, string> = {
  CLAUDE: "Claude",
  OPENROUTER: "OpenRouter",
  CODEX: "Codex",
  ANTIGRAVITY: "Antigravity",
  OPENCODE: "OpenCode",
  MANUAL: "Manual",
};

export function providerName(code: string): string {
  return PROVIDER_NAMES[code as ProviderCode] ?? code;
}

/** What each provider's meters are read from, in four or five words. */
const PROVIDER_ORIGIN: Record<ProviderCode, string> = {
  CLAUDE: "Statusline payload",
  OPENROUTER: "Documented credits API",
  CODEX: "Provider managed payload",
  ANTIGRAVITY: "Provider managed payload",
  OPENCODE: "Authenticated page",
  MANUAL: "Written down by you",
};

export function providerOrigin(code: string): string {
  return PROVIDER_ORIGIN[code as ProviderCode] ?? "";
}

/**
 * The label a bar is announced with.
 *
 * A screen reader hears the same three facts a sighted reader sees: which
 * meter, what the number is, and how much of it to trust.
 */
export function meterLabel(meter: MeterView, percent: string, now: string): string {
  const money = amountSentence(meter);
  return (
    meterName(meter.meter) +
    " at " +
    percent +
    " percent, " +
    freshnessWord[meter.state].toLowerCase() +
    ", " +
    countdown(meter.resetAt, now) +
    (money === null ? "" : ", " + money)
  );
}

/**
 * A credit plan, in money.
 *
 * Only ever called for a reading the normalizer let through with all three of
 * its money fields intact, so there is no half stated case to handle here. The
 * spend is truncated rather than rounded, for the same reason a percentage is:
 * telling somebody they have spent more than they have is the one error worth
 * designing against.
 */
export interface AmountParts {
  /** What has been spent, already formatted with its symbol. */
  spent: string;
  /** What was loaded, already formatted with its symbol. */
  loaded: string;
}

export function amountLine(meter: MeterView): AmountParts | null {
  if (
    meter.usedAmount === undefined ||
    meter.limitAmount === undefined ||
    meter.currency === undefined
  ) return null;
  return {
    spent: "$" + floorFixed(meter.usedAmount, 2),
    loaded: "$" + floorFixed(meter.limitAmount, 2),
  };
}

/** The same two figures as one sentence, for a screen reader and a tooltip. */
export function amountSentence(meter: MeterView): string | null {
  const parts = amountLine(meter);
  return parts === null ? null : parts.spent + " spent of " + parts.loaded + " loaded";
}
