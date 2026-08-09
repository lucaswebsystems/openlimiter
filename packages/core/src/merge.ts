import type { Snapshot } from "./types.js";

/** Hard ceiling on how many snapshots one cache file may carry. */
export const MAX_CACHE_ENTRIES = 64;

/*
 * A provider code and a meter name are both closed uppercase identifiers with
 * no spaces, so joining them with one space cannot collide.
 */
function identity(snapshot: Snapshot): string {
  return snapshot.provider + " " + snapshot.meter;
}

function compareIdentity(left: Snapshot, right: Snapshot): number {
  const leftKey = identity(left);
  const rightKey = identity(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function observedMilliseconds(snapshot: Snapshot): number {
  const parsed = Date.parse(snapshot.observedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Combine cached snapshots with freshly observed ones.
 *
 * One provider and meter pair holds exactly one snapshot. An incoming snapshot
 * replaces the cached snapshot for that pair, every other cached row survives,
 * and the result stays bounded by dropping the least recently observed rows.
 */
export function mergeSnapshots(
  existing: readonly Snapshot[],
  incoming: readonly Snapshot[],
  limit = MAX_CACHE_ENTRIES
): Snapshot[] {
  const byIdentity = new Map<string, Snapshot>();
  for (const snapshot of existing) byIdentity.set(identity(snapshot), snapshot);
  for (const snapshot of incoming) byIdentity.set(identity(snapshot), snapshot);
  const merged = [...byIdentity.values()];
  if (merged.length <= limit) return merged.sort(compareIdentity);
  return merged
    .sort((left, right) => observedMilliseconds(right) - observedMilliseconds(left))
    .slice(0, limit)
    .sort(compareIdentity);
}
