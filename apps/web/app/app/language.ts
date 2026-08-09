import type { Advice, MeterView, ProviderCode, SnapshotState } from "./engine";

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

/** The three pressure bands, plus the band a meter with no reading gets. */
export type Pressure = "healthy" | "watch" | "critical" | "none";

/**
 * The band a percentage falls in.
 *
 * Eighty is the engine's own NEAR_CAP threshold, so critical begins exactly
 * where the advice engine stops recommending a provider. Sixty is a display
 * step in front of it and carries no meaning anywhere else in the product.
 */
export function pressureOf(percent: number): Pressure {
  if (!Number.isFinite(percent)) return "none";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "watch";
  return "healthy";
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
  fresh: "fresh",
  stale: "stale",
  unknown: "unknown",
};

/** The plain sentence under an overall state chip. */
export const reasonSentence: Record<AdviceReason, string> = {
  HEALTHY: "Every readable meter is under 80 percent.",
  NEAR_CAP: "At least one readable meter is at 80 percent or more.",
  AT_CAP: "At least one readable meter has reached its cap.",
  UNKNOWN: "Nothing readable has been supplied yet.",
};

/** The band an overall reason code is painted in. */
export const reasonPressure: Record<AdviceReason, Pressure> = {
  HEALTHY: "healthy",
  NEAR_CAP: "critical",
  AT_CAP: "critical",
  UNKNOWN: "none",
};

/** Why there is no provider to prefer, when there is none. */
export const noRecommendationSentence: Record<string, string> = {
  NO_KNOWN_PROVIDER: "No provider has a readable meter.",
  NO_FRESH_DATA: "Every reading has aged past its own expiry.",
  NO_HEALTHY_PROVIDER: "Every readable provider is at 80 percent or more.",
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
  return (
    meter.meter +
    " at " +
    percent +
    " percent, " +
    freshnessWord[meter.state] +
    ", " +
    countdown(meter.resetAt, now)
  );
}
