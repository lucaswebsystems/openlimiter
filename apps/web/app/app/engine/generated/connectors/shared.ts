/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import type {
  ConnectorLabels,
  ProviderCode,
  RawMeter,
  SnapshotPrecision,
  SnapshotSource,
  SnapshotWindow
} from "../core";

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
}): RawMeter {
  return { ...input, unit: "PERCENT" };
}
