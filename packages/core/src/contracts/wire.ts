import {
  CONNECTOR_VERIFICATIONS,
  SNAPSHOT_KINDS,
  type ConnectorVerification,
  type Snapshot,
  type SnapshotAvailability,
  type SnapshotCurrency,
  type SnapshotKind,
  type SnapshotPrecision,
  type SnapshotSource,
  type VerificationEvidence
} from "../types.js";

export const WIRE_SCHEMA_VERSION_V3 = 3 as const;

export interface WireVerificationEvidence {
  readonly provider_version: string;
  readonly account_shape: string;
  readonly os: string;
  readonly date: string;
}

/** The v2 allowlist, plus seven optional v3 metadata fields. */
export interface WireSampleV3 {
  readonly account_id: string;
  readonly provider: string;
  readonly window_id: string;
  readonly observed_at: string;
  readonly stale: boolean;
  readonly meter?: string;
  readonly code?: string;
  readonly usage_percent?: number | null;
  readonly percent?: number | null;
  readonly reset_at?: string | null;
  readonly resets_at?: string | null;
  readonly amount?: number | null;
  readonly currency?: SnapshotCurrency | null;
  readonly source_period?: readonly [string, string];
  readonly source?: SnapshotSource;
  readonly precision?: SnapshotPrecision;
  readonly verification?: ConnectorVerification;
  readonly verification_evidence?: WireVerificationEvidence;
  readonly kind?: SnapshotKind;
  readonly availability?: SnapshotAvailability;
  readonly retry_at?: string;
}

export interface WireForecastInput {
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly sample_count: number;
  readonly burn_usd_per_day: number;
}

/** API spend remains the v2 shape. */
export interface WireApiSpendSample {
  readonly source_id: string;
  readonly account_id: string;
  readonly provider: string;
  readonly key_label: string;
  readonly month: string;
  readonly spend_usd: number;
  readonly budget_usd: number | null;
  readonly source_period: readonly [string, string];
  readonly currency_source: string;
  readonly raw_unit_scale: number;
  readonly forecast_date: string | null;
  readonly forecast_input: WireForecastInput | null;
  readonly period_complete: boolean;
}

export interface WireEnvelopeV3 {
  readonly event_id: string;
  readonly device_id: string;
  readonly previous_sequence: number;
  readonly sequence: number;
  readonly observed_at: string;
  readonly client_version: string;
  readonly schema_version: typeof WIRE_SCHEMA_VERSION_V3;
  readonly usage_samples: readonly WireSampleV3[];
  readonly api_spend_samples: readonly WireApiSpendSample[];
}

const LOCAL_KEYS = {
  account_id: "accountId", provider: "provider", window_id: "windowId",
  observed_at: "observedAt", stale: "stale", meter: "meter", code: "code",
  usage_percent: "usagePercent", percent: "percent", reset_at: "resetAt",
  resets_at: "resetsAt", amount: "amount", currency: "currency",
  source_period: "sourcePeriod", source: "source", precision: "precision",
  verification: "verification", verification_evidence: "verificationEvidence",
  kind: "kind", availability: "availability", retry_at: "retryAt"
} as const satisfies Record<keyof WireSampleV3, string>;

/**
 * A lossless camelCase projection, not a fabricated Snapshot. The wire does
 * not carry expiresAt, window duration, or the other connector labels.
 */
export type LocalWireSample = {
  readonly [K in keyof WireSampleV3 as (typeof LOCAL_KEYS)[K]]:
    K extends "verification_evidence" ? VerificationEvidence : WireSampleV3[K];
};

const SOURCES = ["native_payload", "documented_api", "internal_payload", "authenticated_page", "manual_entry"] as const satisfies readonly SnapshotSource[];
const PRECISIONS = ["exact", "estimated", "manual"] as const satisfies readonly SnapshotPrecision[];
const CURRENCIES = ["USD", "CNY"] as const satisfies readonly SnapshotCurrency[];
const AVAILABILITIES: Record<SnapshotAvailability, true> = {
  network_failure: true, missing_credentials: true, expired_credentials: true,
  access_denied: true, missing_subscription: true, unlimited: true,
  quota_unavailable: true, rate_limited: true, schema_drift: true
};
const WIRE_AVAILABILITIES = Object.keys(AVAILABILITIES);

function fail(field: string, reason: string): never {
  throw new TypeError(`Invalid wire sample: ${field} ${reason}`);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function closed(row: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(row)) {
    if (!keys.includes(key)) fail(`${field}.${key}`, "is an unknown key");
    if (row[key] === undefined) fail(`${field}.${key}`, "must not be undefined; omit it instead");
  }
}

function instant(value: unknown, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(field, "must be a canonical ISO instant");
}

function numeric(value: unknown, field: string, max: number, exclusive = false): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      (exclusive ? value >= max : value > max)) fail(field, `must be a finite number from 0 to ${max}${exclusive ? " (exclusive)" : ""}`);
}

function member(value: unknown, values: readonly string[], field: string): void {
  if (typeof value !== "string" || !values.includes(value)) fail(field, `must be one of ${values.join(", ")}`);
}

function validateSample(value: unknown): WireSampleV3 {
  const row = record(value, "sample");
  closed(row, Object.keys(LOCAL_KEYS), "sample");
  for (const key of ["account_id", "provider", "window_id"] as const) {
    if (typeof row[key] !== "string" || row[key].length === 0) fail(key, "must be a nonempty string");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(row["account_id"] as string)) fail("account_id", "must be a valid account alias");
  instant(row["observed_at"], "observed_at");
  if (typeof row["stale"] !== "boolean") fail("stale", "must be a boolean");
  for (const key of ["meter", "code"] as const) {
    if (row[key] !== undefined && (typeof row[key] !== "string" || row[key].length === 0)) fail(key, "must be a nonempty string");
  }
  if (row["meter"] === undefined && row["code"] === undefined) fail("meter/code", "requires a meter identifier");
  for (const [left, right] of [["meter", "code"], ["usage_percent", "percent"], ["reset_at", "resets_at"]] as const) {
    if (row[left] !== undefined && row[right] !== undefined && row[left] !== row[right]) fail(`${left}/${right}`, "aliases must agree");
  }
  for (const key of ["reset_at", "resets_at"] as const) {
    if (row[key] !== undefined && row[key] !== null) instant(row[key], key);
  }
  for (const key of ["usage_percent", "percent"] as const) {
    if (row[key] !== undefined && row[key] !== null) numeric(row[key], key, 100_000);
  }
  if (row["amount"] !== undefined && row["amount"] !== null) numeric(row["amount"], "amount", 1e14, true);
  if (row["currency"] !== undefined && row["currency"] !== null) member(row["currency"], CURRENCIES, "currency");
  const codexCredits = row["provider"] === "CODEX" && row["window_id"] === "CREDITS";
  if (row["currency"] != null && row["amount"] == null ||
      row["amount"] != null && row["currency"] == null && !codexCredits) {
    fail("amount/currency", "must be supplied together except for Codex credits");
  }
  if (row["source_period"] !== undefined) {
    const period = row["source_period"];
    if (!Array.isArray(period) || period.length !== 2) fail("source_period", "must contain two ISO instants");
    instant(period[0], "source_period[0]");
    instant(period[1], "source_period[1]");
    if (Date.parse(period[0] as string) > Date.parse(period[1] as string)) fail("source_period", "must be ordered");
  }
  for (const [key, values] of [
    ["source", SOURCES], ["precision", PRECISIONS],
    ["verification", CONNECTOR_VERIFICATIONS], ["kind", SNAPSHOT_KINDS],
    ["availability", WIRE_AVAILABILITIES]
  ] as const) {
    if (row[key] !== undefined) member(row[key], values, key);
  }
  if (row["verification_evidence"] !== undefined) {
    if (row["verification"] !== "VERIFIED_LIVE") fail("verification_evidence", "requires VERIFIED_LIVE");
    const evidence = record(row["verification_evidence"], "verification_evidence");
    closed(evidence, ["provider_version", "account_shape", "os", "date"], "verification_evidence");
    for (const key of ["provider_version", "account_shape", "os"] as const) {
      if (typeof evidence[key] !== "string") fail(`verification_evidence.${key}`, "must be a string");
    }
    instant(evidence["date"], "verification_evidence.date");
  }
  if (row["availability"] !== undefined && (typeof row["usage_percent"] === "number" || typeof row["percent"] === "number")) {
    fail("availability", "cannot accompany a numeric percent");
  }
  if (row["availability"] === undefined && row["usage_percent"] == null && row["percent"] == null && row["amount"] == null) {
    fail("sample", "requires a numeric percent, an amount, or availability");
  }
  if (row["retry_at"] !== undefined) {
    if (row["availability"] !== "rate_limited") fail("retry_at", "requires rate_limited availability");
    instant(row["retry_at"], "retry_at");
  }
  return row as unknown as WireSampleV3;
}

/** No version lives on a sample. The containing envelope declares 2 or 3. */
export function readWireSample(value: unknown): LocalWireSample {
  const wire = validateSample(value);
  const local: Record<string, unknown> = {};
  for (const key of Object.keys(wire) as (keyof WireSampleV3)[]) {
    local[LOCAL_KEYS[key]] = wire[key];
  }
  if (wire.verification_evidence !== undefined) {
    const evidence = wire.verification_evidence;
    local["verificationEvidence"] = {
      providerVersion: evidence.provider_version, accountShape: evidence.account_shape,
      os: evidence.os, date: evidence.date
    };
  }
  return local as LocalWireSample;
}

/**
 * Snapshot inputs use the established unnamed account and meter window rules.
 * staleness is evaluated at conversion time (or an explicit test clock).
 * LocalWireSample inputs preserve the received wire projection exactly.
 */
export function toWireSampleV3(snapshot: Snapshot, now?: string): WireSampleV3;
export function toWireSampleV3(snapshot: LocalWireSample): WireSampleV3;
export function toWireSampleV3(snapshot: Snapshot | LocalWireSample, now = new Date().toISOString()): WireSampleV3 {
  let wire: Record<string, unknown>;
  if ("value" in snapshot) {
    instant(snapshot.expiresAt, "expiresAt");
    instant(now, "now");
    const codexCredits = snapshot.provider === "CODEX" && snapshot.meter === "CREDITS" &&
      snapshot.unit === "CREDITS";
    if (snapshot.unit !== "PERCENT" && snapshot.availability === undefined &&
        snapshot.usedAmount === undefined && !codexCredits) {
      fail("unit", "has no v2 usage representation; use an explicit amount projection");
    }
    wire = {
      account_id: snapshot.accountId ?? "default", provider: snapshot.provider,
      meter: snapshot.meter, window_id: snapshot.meter,
      observed_at: snapshot.observedAt, reset_at: snapshot.resetAt,
      stale: Date.parse(snapshot.expiresAt) <= Date.parse(now),
      source: snapshot.source, precision: snapshot.precision,
      verification: snapshot.labels.verification
    };
    if (snapshot.availability === undefined && snapshot.unit === "PERCENT") wire["usage_percent"] = snapshot.value;
    if (codexCredits && snapshot.availability === undefined) wire["amount"] = snapshot.value;
    if (snapshot.usedAmount !== undefined) wire["amount"] = snapshot.usedAmount;
    if (snapshot.currency !== undefined) wire["currency"] = snapshot.currency;
    if (snapshot.kind !== undefined) wire["kind"] = snapshot.kind;
    if (snapshot.availability !== undefined) wire["availability"] = snapshot.availability;
    if (snapshot.retryAt !== undefined) wire["retry_at"] = snapshot.retryAt;
    if (snapshot.labels.verificationEvidence !== undefined) {
      const evidence = snapshot.labels.verificationEvidence;
      wire["verification_evidence"] = {
        provider_version: evidence.providerVersion, account_shape: evidence.accountShape,
        os: evidence.os, date: evidence.date
      };
    }
  } else {
    wire = {};
    for (const key of Object.keys(LOCAL_KEYS) as (keyof WireSampleV3)[]) {
      const value = snapshot[LOCAL_KEYS[key]];
      if (value !== undefined) wire[key] = value;
    }
    if (snapshot.verificationEvidence !== undefined) {
      const evidence = snapshot.verificationEvidence;
      wire["verification_evidence"] = {
        provider_version: evidence.providerVersion, account_shape: evidence.accountShape,
        os: evidence.os, date: evidence.date
      };
    }
  }
  return validateSample(wire);
}

/** Negotiation is opt in. Existing emitters continue to send v2. */
export function chooseWireVersion(serverAccepted: readonly number[]): 2 | 3 {
  return serverAccepted.includes(WIRE_SCHEMA_VERSION_V3) ? WIRE_SCHEMA_VERSION_V3 : 2;
}
