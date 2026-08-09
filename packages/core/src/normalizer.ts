import {
  PROVIDER_CODES,
  type ConnectorLabels,
  type RawMeter,
  type Snapshot,
  type SnapshotPrecision,
  type SnapshotSource,
  type SnapshotUnit,
  type SnapshotWindow
} from "./types.js";

const units = new Set<SnapshotUnit>(["PERCENT", "CREDITS", "TOKENS", "REQUESTS"]);
const sources = new Set<SnapshotSource>([
  "native_payload",
  "documented_api",
  "internal_payload",
  "authenticated_page",
  "manual_entry"
]);
const precisions = new Set<SnapshotPrecision>(["exact", "estimated", "manual"]);
const providerCodes = new Set<string>(PROVIDER_CODES);
const safeMeter = /^[A-Z][A-Z0-9_]{0,31}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizeWindow(value: unknown): SnapshotWindow | null {
  if (!isRecord(value)) return null;
  const kind = value["kind"];
  if (
    kind !== "rolling" &&
    kind !== "fixed" &&
    kind !== "lifetime" &&
    kind !== "unknown"
  ) return null;
  const duration = value["durationSeconds"];
  if (duration === undefined) return { kind };
  if (
    typeof duration !== "number" ||
    !Number.isInteger(duration) ||
    duration <= 0 ||
    duration > 31_536_000
  ) return null;
  return { kind, durationSeconds: duration };
}

function normalizeLabels(value: unknown): ConnectorLabels | null {
  if (!isRecord(value) || value["verification"] !== "UNVERIFIED") return null;
  const credentialOrigin = value["credentialOrigin"];
  const dataInterfaceStatus = value["dataInterfaceStatus"];
  const automationRisk = value["automationRisk"];
  if (
    credentialOrigin !== "official-local-tool" &&
    credentialOrigin !== "user-key" &&
    credentialOrigin !== "browser-session" &&
    credentialOrigin !== "user-entered"
  ) return null;
  if (
    dataInterfaceStatus !== "native-statusline-payload" &&
    dataInterfaceStatus !== "documented-api" &&
    dataInterfaceStatus !== "internal-endpoint" &&
    dataInterfaceStatus !== "authenticated-scrape" &&
    dataInterfaceStatus !== "manual"
  ) return null;
  if (automationRisk !== "low" && automationRisk !== "high") return null;
  return {
    credentialOrigin,
    dataInterfaceStatus,
    automationRisk,
    verification: "UNVERIFIED"
  };
}

export function normalizeMeter(raw: RawMeter): Snapshot | null {
  if (typeof raw.provider !== "string" || !providerCodes.has(raw.provider)) return null;
  if (typeof raw.meter !== "string" || !safeMeter.test(raw.meter)) return null;
  if (typeof raw.value !== "number" || !Number.isFinite(raw.value) || raw.value < 0) {
    return null;
  }
  if (typeof raw.unit !== "string" || !units.has(raw.unit as SnapshotUnit)) return null;
  if (raw.unit === "PERCENT" && raw.value > 100) return null;
  if (raw.value > 1_000_000_000_000) return null;
  const window = normalizeWindow(raw.window);
  const labels = normalizeLabels(raw.labels);
  if (window === null || labels === null) return null;
  if (raw.resetAt !== null && !isIsoInstant(raw.resetAt)) return null;
  if (typeof raw.source !== "string" || !sources.has(raw.source as SnapshotSource)) {
    return null;
  }
  if (
    typeof raw.precision !== "string" ||
    !precisions.has(raw.precision as SnapshotPrecision)
  ) return null;
  if (!isIsoInstant(raw.observedAt) || !isIsoInstant(raw.expiresAt)) return null;
  if (Date.parse(raw.expiresAt) < Date.parse(raw.observedAt)) return null;
  return {
    provider: raw.provider as Snapshot["provider"],
    meter: raw.meter,
    value: raw.value,
    unit: raw.unit as SnapshotUnit,
    window,
    resetAt: raw.resetAt,
    source: raw.source as SnapshotSource,
    precision: raw.precision as SnapshotPrecision,
    observedAt: raw.observedAt,
    expiresAt: raw.expiresAt,
    labels
  };
}

export function normalizeMeters(rawMeters: readonly RawMeter[]): Snapshot[] {
  return rawMeters.flatMap((raw) => {
    const normalized = normalizeMeter(raw);
    return normalized === null ? [] : [normalized];
  });
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortDeep(value[key])])
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
