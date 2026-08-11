import type {
  ConnectorLabels,
  ProviderCode,
  RawMeter,
  SnapshotAmounts,
  SnapshotPrecision,
  SnapshotSource,
  SnapshotWindow
} from "@openlimiter/core";

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function boundedNumber(value: unknown, maximum = 100): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : null;
}

export function futureInstant(value: unknown, now: string): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  const current = Date.parse(now);
  return Number.isFinite(parsed) && Number.isFinite(current) && parsed > current
    ? new Date(parsed).toISOString()
    : null;
}

/**
 * Largest epoch value that is still read as seconds.
 *
 * A number this size in seconds is the year 33658, and the same number read as
 * milliseconds is 2001. Anything at or above it is therefore a millisecond
 * stamp handed to a seconds field, which is the single most likely way this
 * conversion gets a reset instant wrong, so it is refused rather than turned
 * into a date thirty thousand years away.
 */
export const MAX_EPOCH_SECONDS = 1e12;

/**
 * Slack allowed between a machine's clock and a provider's clock.
 *
 * An hour covers a wrong time zone offset applied to a timestamp, which is the
 * realistic way two correct systems disagree, without widening the plausibility
 * bound below into something that accepts nonsense.
 */
export const CLOCK_SKEW_SECONDS = 3_600;

/**
 * The furthest ahead a window of a given length may plausibly reset.
 *
 * A rolling window cannot reset more than one window from now, so twice the
 * window is already generous, and the skew allowance sits on top of that. This
 * is what stops a five hour meter from claiming it resets in 2038: such a value
 * is not a reset, it is a corrupt field, a different unit, or a different
 * meaning, and rendering a twelve year countdown beside a five hour window
 * would be the product lying with a straight face.
 */
export function plausibleResetHorizon(windowSeconds: number): number {
  return windowSeconds * 2 + CLOCK_SKEW_SECONDS;
}

/**
 * Read a reset instant stated as Unix epoch seconds.
 *
 * Claude Code states its reset times this way. The value must be a finite
 * number, must be in seconds rather than milliseconds, must still be in the
 * future against the supplied clock, because a window that has already reset
 * says nothing about the window running now, and must be close enough to now to
 * belong to the window it claims to describe. Nothing is repaired: a value that
 * fails any of these is null and the caller drops that reading alone.
 *
 * `maxAheadSeconds` is the plausibility bound and is optional only so the
 * helper stays usable for a source with no window length to reason from.
 */
export function futureInstantFromEpochSeconds(
  value: unknown,
  now: string,
  maxAheadSeconds?: number
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value <= 0 || value >= MAX_EPOCH_SECONDS) return null;
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return null;
  const milliseconds = Math.round(value * 1_000);
  if (milliseconds <= current) return null;
  if (
    typeof maxAheadSeconds === "number" &&
    Number.isFinite(maxAheadSeconds) &&
    maxAheadSeconds > 0 &&
    milliseconds > current + maxAheadSeconds * 1_000
  ) return null;
  const instant = new Date(milliseconds);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

/**
 * A fraction of a whole, as Google's quota summary states remaining quota.
 *
 * Zero and one are both real answers, so the bound is inclusive. A boolean is
 * refused explicitly: JavaScript will happily do arithmetic on `true`, and a
 * `remainingFraction` of `true` would otherwise become a usage of zero percent,
 * which is the most dangerous wrong answer this product can give.
 */
export function boundedFraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

/**
 * A whole positive count of seconds, when a provider states a window length.
 *
 * Bounded above by a year, because a rolling window longer than that is not a
 * subscription window, it is a misread field or a different unit.
 */
export const MAX_WINDOW_SECONDS = 31_536_000;

export function windowSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value > 0 && value <= MAX_WINDOW_SECONDS ? value : null;
}

/**
 * Read a reset instant stated as an RFC3339 timestamp.
 *
 * Google's quota summary states reset times this way, and the Antigravity
 * client writes them with SEVEN fractional digits, which `Date.parse` on some
 * runtimes reads and others do not. The fraction is normalised to three digits
 * before parsing, which is the one repair made anywhere in this file, and it is
 * a repair of ENCODING rather than of value: the instant it names is unchanged.
 * Recorded 2026-08-07 against a real credential and a real response.
 *
 * An offsetless stamp is read as UTC explicitly. Both observed sources carry an
 * offset today, so this is a guard rather than a fix, and it exists because the
 * alternative is silent: a naive stamp read as local time moves a reset by the
 * machine's offset instead of failing.
 */
export function futureInstantFromRfc3339(
  value: unknown,
  now: string,
  maxAheadSeconds?: number
): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const trimmed = value.trim();
  /* Three digits is what every runtime agrees on; the rest are dropped, not
     rounded, because sub millisecond precision on a quota reset is noise. */
  const normalized = trimmed.replace(
    /\.(\d{1,9})/u,
    (_match, digits: string) => "." + (digits + "000").slice(0, 3)
  );
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(normalized)
    ? normalized
    : normalized + "Z";
  const parsed = Date.parse(withZone);
  const current = Date.parse(now);
  if (!Number.isFinite(parsed) || !Number.isFinite(current)) return null;
  if (parsed <= current) return null;
  if (
    typeof maxAheadSeconds === "number" &&
    Number.isFinite(maxAheadSeconds) &&
    maxAheadSeconds > 0 &&
    parsed > current + maxAheadSeconds * 1_000
  ) return null;
  return new Date(parsed).toISOString();
}

/** How many seconds each unit a provider spells out is worth. */
const DURATION_UNITS: Readonly<Record<string, number>> = {
  day: 86_400,
  hour: 3_600,
  minute: 60,
  second: 1
};

/**
 * Seconds from a duration a page spelled out in words, or null.
 *
 * OpenCode's workspace page prints "Resets in 5 days 20 hours" rather than a
 * timestamp, so the only reset available is a countdown rendered for a human.
 * Only consecutive number and unit pairs are read, and an empty or zero total
 * is null rather than now: a reset of zero seconds would render as a countdown
 * that has already finished.
 */
export function durationSecondsFromWords(text: string): number | null {
  let total = 0;
  let seen = false;
  const pattern = /(\d{1,6})\s*(day|hour|minute|second)s?/giu;
  for (const match of text.matchAll(pattern)) {
    const count = Number.parseInt(match[1] ?? "", 10);
    const unit = DURATION_UNITS[(match[2] ?? "").toLowerCase()];
    if (!Number.isFinite(count) || unit === undefined) return null;
    total += count * unit;
    seen = true;
  }
  if (!seen || total <= 0 || total > MAX_WINDOW_SECONDS) return null;
  return total;
}

/** An instant this many seconds after the supplied clock, or null. */
export function instantAfter(now: string, seconds: number): string | null {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return null;
  const instant = new Date(current + seconds * 1_000);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

export function shortExpiry(now: string): string | null {
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? new Date(parsed + 60_000).toISOString() : null;
}

export function rawMeter(input: {
  provider: ProviderCode;
  meter: string;
  value: number;
  window: SnapshotWindow;
  resetAt: string | null;
  source: SnapshotSource;
  precision: SnapshotPrecision;
  observedAt: string;
  expiresAt: string;
  labels: ConnectorLabels;
  /**
   * Money, when the provider's own documented payload states it.
   *
   * Passed through untouched. The normalizer is the only thing that decides
   * whether these are believable, and it drops all three together or keeps all
   * three together, so a connector never has to reason about the pair.
   */
  amounts?: SnapshotAmounts;
}): RawMeter {
  const { amounts, ...rest } = input;
  return { ...rest, unit: "PERCENT", ...(amounts === undefined ? {} : amounts) };
}
