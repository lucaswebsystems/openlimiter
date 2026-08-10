/**
 * When a connection may next ask its provider a question.
 *
 * Background collection is the difference between a quota monitor and a file
 * viewer, and a collector that retries a failing provider on a fixed interval
 * is how a monitor gets an account rate limited. The whole policy lives here as
 * arithmetic over injected values: the caller supplies the clock and the random
 * source, so a schedule is exactly reproducible in a test and identical on all
 * three operating systems.
 */

/** Longest our own backoff will ever grow to on its own. */
export const REFRESH_BACKOFF_CEILING_SECONDS = 3_600;

/**
 * Longest a provider may push us out with Retry-After.
 *
 * The header is honoured because the provider knows its own limits better than
 * we do, but a header is still input from outside, and a day is already far
 * past the point where a person would reconnect by hand.
 */
export const REFRESH_RETRY_AFTER_CEILING_SECONDS = 86_400;

/** How far either side of the computed delay the jitter may move it. */
export const REFRESH_JITTER_RATIO = 0.2;

export interface RefreshInput {
  /**
   * Consecutive failures behind this schedule. Zero means the last attempt
   * succeeded, so the delay is the plain interval with jitter on it.
   */
  attempt: number;
  /** The interval this connection uses when nothing is failing, in seconds. */
  baseSeconds: number;
  /** Retry-After in seconds when the provider sent one, otherwise null. */
  retryAfterSeconds?: number | null;
  /** Injected uniform random in the range zero to one. */
  random: () => number;
}

function usableRandom(random: () => number): number {
  let value: number;
  try {
    value = random();
  } catch {
    return 0.5;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(Math.max(value, 0), 1);
}

function usableBase(baseSeconds: number): number {
  if (!Number.isFinite(baseSeconds) || baseSeconds <= 0) return 1;
  return Math.min(baseSeconds, REFRESH_BACKOFF_CEILING_SECONDS);
}

function usableAttempt(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return 0;
  /*
   * The exponent is clamped before it is used rather than after. Two to the
   * power of a large attempt count overflows to Infinity long before the
   * ceiling below could catch it, and Infinity times a jitter factor is not a
   * date.
   */
  return Math.min(Math.floor(attempt), 32);
}

function usableRetryAfter(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(value, REFRESH_RETRY_AFTER_CEILING_SECONDS);
}

/**
 * The delay before the next attempt, in seconds.
 *
 * Doubling per consecutive failure, capped at an hour, then jittered by up to
 * a fifth either way so a hundred installations that all failed at the same
 * moment do not all come back at the same moment.
 *
 * The order matters and is the whole subtlety here. Jitter is applied to OUR
 * backoff and to nothing else, and the provider's Retry-After is then taken as
 * a floor underneath the jittered result. Jittering a Retry-After instead would
 * subtract up to a fifth from an instruction the provider gave us: a header
 * asking for a day back would come back as nineteen hours and knock on the door
 * almost five hours early, which is precisely the behaviour that gets an account
 * limited harder. Jitter exists to spread our own retries, so it may only ever
 * move our own number. A Retry-After shorter than our backoff changes nothing,
 * because a provider cannot talk us out of backing off.
 */
export function refreshDelaySeconds(input: RefreshInput): number {
  const base = usableBase(input.baseSeconds);
  const attempt = usableAttempt(input.attempt);
  const backoff = Math.min(
    base * Math.pow(2, attempt),
    REFRESH_BACKOFF_CEILING_SECONDS
  );
  const jitter = 1 + (usableRandom(input.random) * 2 - 1) * REFRESH_JITTER_RATIO;
  const jittered = backoff * jitter;
  const retryAfter = usableRetryAfter(input.retryAfterSeconds);
  return retryAfter === null ? jittered : Math.max(jittered, retryAfter);
}

/**
 * The instant of the next attempt, or null when the supplied clock is not a
 * readable instant. Nothing is guessed from a clock we cannot read.
 */
export function nextRefreshAt(now: string, input: RefreshInput): string | null {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return null;
  const milliseconds = current + Math.round(refreshDelaySeconds(input) * 1_000);
  if (!Number.isFinite(milliseconds)) return null;
  const next = new Date(milliseconds);
  return Number.isFinite(next.getTime()) ? next.toISOString() : null;
}

/**
 * Whether a scheduled instant has arrived.
 *
 * A schedule we cannot read counts as due. The alternative is a connection that
 * never refreshes again because one unreadable value got written once, and the
 * first successful attempt replaces it with a readable one. A clock we cannot
 * read is the opposite case and counts as not due, because with no present
 * moment there is nothing to compare against.
 */
export function isDue(nextAt: string | null, now: string): boolean {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return false;
  if (nextAt === null) return true;
  const scheduled = Date.parse(nextAt);
  if (!Number.isFinite(scheduled)) return true;
  return current >= scheduled;
}
