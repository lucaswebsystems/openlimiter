/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import type { SnapshotState } from "./types";

function parseInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function freshness(
  observedAt: string,
  expiresAt: string,
  now: string
): SnapshotState {
  const observed = parseInstant(observedAt);
  const expires = parseInstant(expiresAt);
  const current = parseInstant(now);
  if (observed === null || expires === null || current === null) return "unknown";
  if (expires < observed || observed > current) return "unknown";
  return current <= expires ? "fresh" : "stale";
}
