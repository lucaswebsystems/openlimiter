/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import type { Snapshot } from "./types";

/** Hard ceiling on how many snapshots one cache file may carry. */
export const MAX_CACHE_ENTRIES = 64;

/*
 * A provider code, a meter name and an account id are all closed identifiers
 * with no spaces, so joining them with one space cannot collide.
 *
 * The account id joins the key only when the row states one. A row without an
 * account therefore keys exactly as it always did, which is what lets a cache
 * written before accounts existed merge with one written after without any row
 * changing identity or duplicating itself. Two rows for the same meter under
 * different accounts are two rows, which is the whole point of the field.
 */
export function snapshotIdentity(snapshot: Snapshot): string {
  const base = snapshot.provider + " " + snapshot.meter;
  return snapshot.accountId === undefined ? base : base + " " + snapshot.accountId;
}

const identity = snapshotIdentity;

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
