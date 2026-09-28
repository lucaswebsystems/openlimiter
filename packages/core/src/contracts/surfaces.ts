import { PROVIDER_CODES, SNAPSHOT_KINDS, type ProviderCode, type SnapshotKind, type SnapshotPrecision } from "../types.js";
import { SNAPSHOT_AVAILABILITIES, type SnapshotAvailability } from "../connection-state.js";
import { MAX_LIVE_ACTIVITY_SESSIONS, hasOnlyContractKeys, isContractInstant, isContractObject } from "../activity/contract.js";

export const USAGE_BAND_THRESHOLDS = { yellow: 60, orange: 80, red: 90 } as const;
export type SurfaceBand = "green" | "yellow" | "orange" | "red" | "stale";
export interface SessionsSummary {
  busy: number;
  waiting: number;
  done: number;
  idle: number;
  unknown: number;
}
/** Meter identity, meaning and reset travel as one object on every surface. */
export interface SurfaceAccountRow {
  provider: ProviderCode;
  account: string | null;
  headlineMeterId: string;
  kind: SnapshotKind | "unknown";
  value: number | null;
  meaning: "used" | "remaining";
  windowLabel: string;
  resetAt: string | null;
  freshness: "fresh" | "stale" | "unknown";
  availability: "available" | SnapshotAvailability;
  band: SurfaceBand;
  precision: SnapshotPrecision | "unknown";
  /** null only for exact reported precision. */
  fidelityMarker: "estimated" | "manual" | "unknown" | null;
  sessions: SessionsSummary;
}
export type TrayAccountViewModel = SurfaceAccountRow;
export type RailAccountViewModel = SurfaceAccountRow;

/** Percent bands always describe consumption, even when the row shows remaining. */
export function usageBand(usedPercent: number, freshness: SurfaceAccountRow["freshness"] = "fresh"): SurfaceBand {
  if (freshness !== "fresh" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return "stale";
  return usedPercent >= USAGE_BAND_THRESHOLDS.red ? "red" : usedPercent >= USAGE_BAND_THRESHOLDS.orange ? "orange" :
    usedPercent >= USAGE_BAND_THRESHOLDS.yellow ? "yellow" : "green";
}
function usedPercent(row: SurfaceAccountRow): number | null {
  if (row.kind !== "quota_percent" || row.availability !== "available" || row.freshness !== "fresh" ||
    row.value === null || !Number.isFinite(row.value) || row.value < 0 || row.value > 100) return null;
  return row.meaning === "remaining" ? 100 - row.value : row.value;
}
const shortText = (value: unknown): value is string => typeof value === "string" && value["length"] > 0 &&
  value["length"] <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
export function isSurfaceAccountRow(value: unknown): value is SurfaceAccountRow {
  if (!isContractObject(value) || !hasOnlyContractKeys(value, ["provider", "account", "headlineMeterId", "kind", "value", "meaning",
    "windowLabel", "resetAt", "freshness", "availability", "band", "precision", "fidelityMarker", "sessions"]) ||
    !(PROVIDER_CODES as readonly unknown[]).includes(value["provider"]) || !(value["account"] === null || shortText(value["account"])) ||
    !shortText(value["headlineMeterId"]) || !shortText(value["windowLabel"]) ||
    !(value["resetAt"] === null || isContractInstant(value["resetAt"])) ||
    ![...SNAPSHOT_KINDS, "unknown"].includes(value["kind"] as SnapshotKind | "unknown") ||
    !["used", "remaining"].includes(value["meaning"] as string) || !["fresh", "stale", "unknown"].includes(value["freshness"] as string) ||
    !["available", ...SNAPSHOT_AVAILABILITIES].includes(value["availability"] as "available" | SnapshotAvailability) ||
    !["exact", "estimated", "manual", "unknown"].includes(value["precision"] as string)) return false;
  if (value["value"] !== null && (typeof value["value"] !== "number" || !Number.isFinite(value["value"]) || value["value"] < 0)) return false;
  if (value["availability"] !== "available" && value["value"] !== null) return false;
  if (value["kind"] === "quota_percent" && typeof value["value"] === "number" && value["value"] > 100) return false;
  if (value["fidelityMarker"] !== (value["precision"] === "exact" ? null : value["precision"])) return false;
  const sessions = value["sessions"];
  const keys = ["busy", "waiting", "done", "idle", "unknown"];
  if (!isContractObject(sessions) || !hasOnlyContractKeys(sessions, keys) ||
    !keys.every((key) => Number.isSafeInteger(sessions[key]) && (sessions[key] as number) >= 0) ||
    keys.reduce((total, key) => total + (sessions[key] as number), 0) > MAX_LIVE_ACTIVITY_SESSIONS) return false;
  const row = value as unknown as SurfaceAccountRow;
  const used = usedPercent(row);
  return row.band === (used === null ? "stale" : usageBand(used));
}

export type TraySummary = {
  state: "numeric";
  /** Highest fresh quota consumption; ties preserve the caller's account order. */
  selected: SurfaceAccountRow;
  value: number;
  meaning: "used";
  band: Exclude<SurfaceBand, "stale">;
  partial: boolean;
  includedRows: number;
  excludedRows: number;
} | {
  state: "unknown";
  selected: null;
  value: null;
  meaning: "used";
  band: "stale";
  partial: boolean;
  includedRows: 0;
  excludedRows: number;
};

/** Select one comparable quota, never sum or average unrelated provider balances. */
export function traySummary(rows: readonly SurfaceAccountRow[]): TraySummary {
  let selected: SurfaceAccountRow | null = null;
  let maximum = -1;
  let includedRows = 0;
  for (const row of rows) {
    if (!isSurfaceAccountRow(row)) continue;
    const used = usedPercent(row);
    if (used === null) continue;
    includedRows++;
    if (used > maximum) { selected = row; maximum = used; }
  }
  const excludedRows = rows.length - includedRows;
  const partial = includedRows > 0 && excludedRows > 0;
  if (selected === null) return { state: "unknown", selected: null, value: null, meaning: "used", band: "stale", partial, includedRows: 0, excludedRows };
  return { state: "numeric", selected, value: maximum, meaning: "used", band: usageBand(maximum) as Exclude<SurfaceBand, "stale">,
    partial, includedRows, excludedRows };
}
