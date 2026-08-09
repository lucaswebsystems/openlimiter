import { freshness } from "./freshness.js";
import {
  PROVIDER_CODES,
  type Advice,
  type AdviceProvider,
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
  return { inject: true, reason, providers: known, unknownProviders };
}
