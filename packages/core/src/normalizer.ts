import {
  ACCOUNT_ID_PATTERN,
  MAX_SNAPSHOT_AMOUNT,
  PROVIDER_CODES,
  SNAPSHOT_OBSERVED_VIA,
  SNAPSHOT_SOURCE_KINDS,
  UNKNOWN_PROVENANCE,
  type ConnectorLabels,
  type ProviderCode,
  type RawMeter,
  type Snapshot,
  type SnapshotAmounts,
  type SnapshotCurrency,
  type SnapshotObservedVia,
  type SnapshotPrecision,
  type SnapshotProvenance,
  type SnapshotSource,
  type SnapshotSourceKind,
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
const currencies = new Set<SnapshotCurrency>(["USD"]);
const providerCodes = new Set<string>(PROVIDER_CODES);
const sourceKinds = new Set<string>(SNAPSHOT_SOURCE_KINDS);
const observedVia = new Set<string>(SNAPSHOT_OBSERVED_VIA);
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

/**
 * Validate the money amounts, as one unit or not at all.
 *
 * They arrive together or they do not arrive, and they leave together or they
 * do not leave. Any one of them being absent, out of range, the wrong type, or
 * inconsistent with the other drops all three, which is what keeps a card from
 * ever printing a spend with no plan size beside it. The percentage on the same
 * reading is untouched by this: a provider that misreports its money has not
 * misreported how full the meter is.
 */
function normalizeAmounts(raw: RawMeter): SnapshotAmounts | null {
  const used = raw.usedAmount;
  const limit = raw.limitAmount;
  const currency = raw.currency;
  if (used === undefined && limit === undefined && currency === undefined) return null;
  if (typeof used !== "number" || typeof limit !== "number") return null;
  if (typeof currency !== "string" || !currencies.has(currency as SnapshotCurrency)) {
    return null;
  }
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return null;
  if (used < 0 || limit < 0) return null;
  if (used > limit) return null;
  if (used > MAX_SNAPSHOT_AMOUNT || limit > MAX_SNAPSHOT_AMOUNT) return null;
  return { usedAmount: used, limitAmount: limit, currency: currency as SnapshotCurrency };
}

/**
 * Read the account this reading belongs to.
 *
 * Absent is the ordinary case and means one unnamed account. Present but
 * malformed is the dangerous case, because an identity we cannot trust would
 * quietly split or merge a user's meters in the cache, so that row is refused
 * outright rather than stripped back to the unnamed account.
 */
function readAccountId(value: unknown): { ok: true; accountId: string | null } |
  { ok: false } {
  if (value === undefined) return { ok: true, accountId: null };
  if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) return { ok: false };
  return { ok: true, accountId: value };
}

/**
 * Read how the observation arrived.
 *
 * The opposite call to the one above, and deliberately so. Provenance is a
 * label on a reading, not part of its identity, so a provenance we cannot read
 * costs the reading nothing: it becomes unknown and the number survives. Either
 * field failing makes the whole thing unknown, because half a provenance would
 * invite a surface to describe a source it cannot actually vouch for.
 */
function readProvenance(value: unknown): SnapshotProvenance | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return UNKNOWN_PROVENANCE;
  const kind = value["sourceKind"];
  const via = value["observedVia"];
  if (typeof kind !== "string" || !sourceKinds.has(kind)) return UNKNOWN_PROVENANCE;
  if (typeof via !== "string" || !observedVia.has(via)) return UNKNOWN_PROVENANCE;
  return {
    sourceKind: kind as SnapshotSourceKind,
    observedVia: via as SnapshotObservedVia
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
  const account = readAccountId(raw.accountId);
  if (!account.ok) return null;
  const provenance = readProvenance(raw.provenance);
  const amounts = normalizeAmounts(raw);
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
    labels,
    ...(amounts === null ? {} : amounts),
    ...(account.accountId === null ? {} : { accountId: account.accountId }),
    ...(provenance === null ? {} : { provenance })
  };
}

export function normalizeMeters(rawMeters: readonly RawMeter[]): Snapshot[] {
  return rawMeters.flatMap((raw) => {
    const normalized = normalizeMeter(raw);
    return normalized === null ? [] : [normalized];
  });
}

/**
 * What survived validation, and who lost a reading to it.
 *
 * `normalizeMeters` above answers the only question the engine ever asks: what
 * may be believed. A human surface has a second question, which is why a card
 * is empty when a document clearly mentioned that provider, and this is the
 * seam that answers it without changing the first.
 *
 * A rejected reading is only attributed when its provider code was itself
 * valid. Anything else is counted and left anonymous rather than blamed on a
 * provider that a hostile document happened to name.
 */
export interface NormalizeReport {
  snapshots: Snapshot[];
  /** Providers that had at least one reading refused. Never a guess. */
  rejected: readonly ProviderCode[];
  /** How many readings were dropped in total, attributable or not. */
  dropped: number;
}

export function normalizeMetersReport(
  rawMeters: readonly RawMeter[]
): NormalizeReport {
  const snapshots: Snapshot[] = [];
  const rejected = new Set<ProviderCode>();
  let dropped = 0;
  for (const raw of rawMeters) {
    const normalized = normalizeMeter(raw);
    if (normalized !== null) {
      snapshots.push(normalized);
      continue;
    }
    dropped += 1;
    if (typeof raw.provider === "string" && providerCodes.has(raw.provider)) {
      rejected.add(raw.provider as ProviderCode);
    }
  }
  return { snapshots, rejected: [...rejected], dropped };
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
