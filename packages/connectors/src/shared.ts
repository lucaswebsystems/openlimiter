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
