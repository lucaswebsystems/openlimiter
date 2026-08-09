import { freshness } from "./freshness.js";
import {
  PROVIDER_CODES,
  type Advice,
  type AdviceProvider,
  type AdviceRecommendation,
  type ProviderCode,
  type Snapshot
} from "./types.js";

function reasonFor(percent: number): Advice["reason"] {
  if (percent >= 100) return "AT_CAP";
  if (percent >= 80) return "NEAR_CAP";
  return "HEALTHY";
}

const priority: Record<Advice["reason"], number> = {
  UNKNOWN: 0,
  HEALTHY: 1,
  NEAR_CAP: 2,
  AT_CAP: 3
};

function recommendationFor(known: readonly AdviceProvider[]): AdviceRecommendation {
  const fresh = known.filter((provider) => provider.state === "fresh");
  if (fresh.length === 0) {
    return { code: "NONE", provider: null, reason: "NO_FRESH_DATA" };
  }
  const usable = fresh.filter((provider) => provider.usagePercent < 80);
  if (usable.length === 0) {
    return { code: "NONE", provider: null, reason: "NO_HEALTHY_PROVIDER" };
  }
  let best = usable[0]!;
  for (const candidate of usable.slice(1)) {
    if (candidate.usagePercent < best.usagePercent) best = candidate;
  }
  const tied = usable.filter(
    (candidate) => candidate.usagePercent === best.usagePercent
  ).length > 1;
  return {
    code: "PREFER",
    provider: best.provider,
    reason: tied ? "ORDERED_TIE_BREAK" : "LOWEST_USAGE"
  };
}

export function buildAdvice(
  snapshots: readonly Snapshot[],
  now: string,
  expectedProviders: readonly ProviderCode[] = PROVIDER_CODES
): Advice {
  const known: AdviceProvider[] = [];
  for (const provider of expectedProviders) {
    const candidates = snapshots
      .filter((snapshot) => snapshot.provider === provider && snapshot.unit === "PERCENT")
      .map((snapshot) => ({
        snapshot,
        state: freshness(snapshot.observedAt, snapshot.expiresAt, now)
      }))
      .filter(
        (entry): entry is { snapshot: Snapshot; state: "fresh" | "stale" } =>
          entry.state !== "unknown"
      )
      .sort((left, right) => right.snapshot.value - left.snapshot.value);
    const worst = candidates[0];
    if (worst !== undefined) {
      known.push({
        provider,
        state: worst.state,
        usagePercent: worst.snapshot.value,
        resetAt: worst.snapshot.resetAt
      });
    }
  }
  if (known.length === 0) {
    return {
      inject: false,
      reason: "UNKNOWN",
      recommendation: {
        code: "NONE",
        provider: null,
        reason: "NO_KNOWN_PROVIDER"
      },
      providers: [],
      unknownProviders: [...expectedProviders]
    };
  }
  const unknownProviders = expectedProviders.filter(
    (provider) => !known.some((entry) => entry.provider === provider)
  );
  const reason = known
    .map((entry) => reasonFor(entry.usagePercent))
    .reduce(
      (worst, current) => priority[current] > priority[worst] ? current : worst,
      "HEALTHY" as Advice["reason"]
    );
  return {
    inject: true,
    reason,
    recommendation: recommendationFor(known),
    providers: known,
    unknownProviders
  };
}
