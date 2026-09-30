/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import { floorFixed } from "./format";
import { WAVE_PROVIDERS } from "./providers/index";
import type { Snapshot, SnapshotAmounts, SnapshotCurrency, SnapshotUnit } from "./types";

export const RETENTION_MILLISECONDS = 7 * 86_400_000;

/* ------------------------------------------------------------------ *
 * The meter contract. Rust twin: data_rules::measure.
 *
 * One answer to "what is this number", read by every surface, so no surface
 * decides it alone. The rules, frozen for the 2.1 providers:
 *
 *   A PERCENT value is always the USED share, 0 to 100. A reader that is handed
 *   a remaining share converts it once, at parse time. A percent may name the
 *   kind of quota it measures, but not the opposite direction: money_balance
 *   on a percent is refused, unless the row carries the used and limit pair
 *   that makes it the used share of that money (OpenRouter's shape since 2.0).
 *   Direction on any other unit comes from `kind` and from nothing else:
 *   money_balance is what REMAINS, spend and token_count are what was USED.
 *   A non percent reading with no kind is an amount whose direction nobody
 *   stated, so no surface prints "left" or "spent" beside it.
 *   Only a percent reading has a bar and a band, because only it has a stated
 *   denominator. Every other measure is its amount, in its own unit.
 *   Money is money only with a currency, and the currency is never converted.
 *   Unlimited is an availability, never a meter: see CONNECTION_NOTE_REASONS.
 * ------------------------------------------------------------------ */

/**
 * What one reading's number is.
 *
 *   percent  a used share of a quota
 *   balance  what is left, in its own unit (kind money_balance)
 *   spend    what was spent, in its own unit (kind spend)
 *   count    a used count of tokens or requests (kind token_count)
 *   amount   a number in its own unit whose reader never said which way it points
 */
export type MeterMeasure = "percent" | "balance" | "spend" | "count" | "amount";

export interface MeterReading {
  measure: MeterMeasure;
  /** Consumption, what is left, or null when the reader never said. */
  direction: "used" | "remaining" | null;
  unit: SnapshotUnit;
  /** The stated currency, never converted; null when the number is not money. */
  currency: SnapshotCurrency | null;
  /** The number in its own unit. For a percent reading, the used share. */
  value: number;
  /** The used share a bar and a band may draw. Null for every other measure. */
  usedPercent: number | null;
  /** Money spent out of a money limit, when the provider stated both. */
  money: SnapshotAmounts | null;
}

const MEASURE_BY_KIND = {
  money_balance: ["balance", "remaining"],
  spend: ["spend", "used"],
  token_count: ["count", "used"]
} as const;

/**
 * Read one row under the contract, or null when it is not a reading at all.
 *
 * Null for an availability (including unlimited), for runtime information,
 * and for a row whose unit and kind contradict each other: a percent that
 * claims to be what is left with no money pair to prove otherwise, or a quota
 * percent stated in credits. A surface that gets null draws nothing, and
 * displayReason below has already flagged it.
 */
export function meterReading(row: Snapshot): MeterReading | null {
  if (row.availability !== undefined || row.kind === "runtime_info") return null;
  if (!Number.isFinite(row.value) || row.value < 0) return null;
  const money = row.usedAmount !== undefined && row.limitAmount !== undefined && row.currency !== undefined
    ? { usedAmount: row.usedAmount, limitAmount: row.limitAmount, currency: row.currency }
    : null;
  if (row.unit === "PERCENT") {
    if ((row.kind === "money_balance" && money === null) || row.value > 100) return null;
    return {
      measure: "percent", direction: "used", unit: row.unit, currency: money?.currency ?? null,
      value: row.value, usedPercent: row.value, money
    };
  }
  if (row.kind === "quota_percent") return null;
  /* The one shape written before the contract: credits with a used and limit
     pair and no kind. Its value is the used share of that money limit, and it
     keeps drawing exactly as it always did. */
  if (row.kind === undefined && money !== null) {
    if (row.value > 100) return null;
    return {
      measure: "percent", direction: "used", unit: row.unit, currency: money.currency,
      value: row.value, usedPercent: row.value, money
    };
  }
  const [measure, direction] = row.kind === undefined ? ["amount", null] as const : MEASURE_BY_KIND[row.kind];
  return {
    measure, direction, unit: row.unit, currency: row.currency ?? null,
    value: row.value, usedPercent: null, money
  };
}

const CURRENCY_PREFIX: Readonly<Record<SnapshotCurrency, string>> = { USD: "$", CNY: "CN¥" };
const UNIT_WORDS: Readonly<Record<Exclude<SnapshotUnit, "PERCENT">, readonly [string, string]>> = {
  CREDITS: ["credit", "credits"],
  REQUESTS: ["request", "requests"],
  TOKENS: ["token", "tokens"]
};

/** An amount of money in the currency it was stated in: "$12.34", "CN¥8.00". */
export function moneyText(amount: number, currency: SnapshotCurrency): string {
  return CURRENCY_PREFIX[currency] + floorFixed(amount, 2);
}

/**
 * A reading's number in its own unit: "$12.34", "CN¥8.00", "12.47 credits",
 * "120 requests", "35.5%". Truncated, never rounded up, like every number here.
 * Credits keep two decimals because credits are fractional; a whole count of
 * requests or tokens prints as a whole number. Direction words are the
 * surface's to add, from `direction`.
 */
export function meterAmountText(reading: MeterReading): string {
  if (reading.unit === "PERCENT") return floorFixed(reading.value, 1) + "%";
  if (reading.currency !== null) return moneyText(reading.value, reading.currency);
  const [one, many] = UNIT_WORDS[reading.unit];
  const number = reading.unit !== "CREDITS" && Number.isInteger(reading.value)
    ? String(reading.value)
    : floorFixed(reading.value, 2);
  return number + " " + (reading.value === 1 ? one : many);
}

/**
 * Reasons that are a note on Connections rather than something to fix.
 *
 * Unlimited is an answer: the provider says this account has no cap. It is
 * never a meter, because a zero percent bar would claim a cap that does not
 * exist, and it is not a problem to fix either, so it never counts toward
 * Needs attention. It keeps its flag and fix kind below so every surface that
 * reads flags still hides it from Home, the panel and the tray.
 */
export const CONNECTION_NOTE_REASONS = ["unlimited"] as const;

export function isConnectionNote(reason: string): boolean {
  return (CONNECTION_NOTE_REASONS as readonly string[]).includes(reason);
}

/*
 * Seconds between desktop reads, per provider. Rust twin:
 * request_policy::provider_interval_seconds, held equal by a test in
 * data_rules.rs. A 2.1 provider states its own in its descriptor.
 */
const desktopIntervals: Readonly<Record<string, number>> = {
  CLAUDE: 900, GEMINI_CLI: 900, ANTIGRAVITY: 600, CODEX: 300, CURSOR: 300, GROK: 300, KIMI: 300, OPENROUTER: 300, OPENCODE: 300,
  ...Object.fromEntries(WAVE_PROVIDERS.map((provider) => [provider.code, provider.intervalSeconds]))
};

/** Rust twin: data_rules::freshness_policy. Poll jitter plus bounded request latency. */
export function freshnessPolicy(input: { sourceClass: string; observedAt: string; now: string; provider?: string; writer?: string }) {
  const interval = input.sourceClass === "native_payload" ? 60
    : input.writer === "desktop" ? desktopIntervals[input.provider ?? ""] ?? 900 : 900;
  const ttlSeconds = interval * 1.2 + 60;
  const observed = Date.parse(input.observedAt);
  const now = Date.parse(input.now);
  const deadline = observed + ttlSeconds * 1000;
  const expiresAt = Number.isFinite(deadline) ? new Date(deadline).toISOString() : input.observedAt;
  return { ttlSeconds, expiresAt, availability: !Number.isFinite(now) || !Number.isFinite(observed) || now < observed
    ? "unavailable" : now < deadline ? "fresh" : "stale" };
}

export function retainSnapshots(rows: readonly Snapshot[], now: number): Snapshot[] {
  return rows.filter(row => Date.parse(row.observedAt) >= now - RETENTION_MILLISECONDS);
}

export type FixKind = "reconnect" | "open_app" | "sign_in" | "switch_on" | "unsupported";
export interface ConnectionFlag {
  provider: Snapshot["provider"];
  accountId?: string;
  reason: string;
  fixKind: FixKind;
}

export function fixKind(reason: string): FixKind {
  if (reason === "disabled") return "switch_on";
  if (reason === "missing_credentials") return "sign_in";
  if (["expired_credentials", "stale", "rate_limited", "network_failure", "not_measured"].includes(reason)) return "open_app";
  if (["quota_unavailable", "unlimited", "placeholder", "schema_drift"].includes(reason)) return "unsupported";
  return "reconnect";
}

export function displayReason(row: Snapshot, now: string): string | null {
  if (row.availability !== undefined) return row.availability;
  if (row.window.kind === "unknown" || row.kind === "runtime_info" || row.meter === "ACQUISITION") return "placeholder";
  if (!Number.isFinite(row.value) || row.value < 0 || (row.unit === "PERCENT" && row.value > 100)) return "quota_unavailable";
  // A unit and kind that contradict each other have no reading to draw.
  if (meterReading(row) === null) return "quota_unavailable";
  if (freshnessPolicy({ ...row, sourceClass: row.source, now }).availability !== "fresh") return "stale";
  return null;
}

/** Active identities come from credentials or connections, never observation age. */
export function projectSnapshots(rows: readonly Snapshot[], now: string, active?: ReadonlyMap<string, ReadonlySet<string>>): { snapshots: Snapshot[]; flags: ConnectionFlag[] } {
  const snapshots: Snapshot[] = [];
  const flags = new Map<string, ConnectionFlag>();
  for (const row of rows) {
    const accounts = active?.get(row.provider);
    const foreign = accounts !== undefined && (!row.accountId || !accounts.has(row.accountId));
    const note = row.availability !== undefined && isConnectionNote(row.availability);
    /* A note speaks for the account connected now, and only while it is
       fresh; every other availability stays the flag it always was. */
    const reason = row.availability !== undefined && !note ? row.availability
      : foreign ? "account_not_connected"
      : note ? (freshnessPolicy({ ...row, sourceClass: row.source, now }).availability === "fresh" ? row.availability! : "stale")
      : displayReason(row, now);
    if (reason === null) snapshots.push({ ...row, expiresAt: freshnessPolicy({ ...row, sourceClass: row.source, now }).expiresAt });
    else flags.set([row.provider, row.accountId, reason].join(":"), {
      provider: row.provider, ...(row.accountId ? { accountId: row.accountId } : {}), reason, fixKind: fixKind(reason)
    });
  }
  return { snapshots, flags: [...flags.values()] };
}
