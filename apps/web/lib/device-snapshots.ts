/**
 * Meter contract v2, as the paired phone reads it.
 *
 * The hosted read returns one row per meter with a percentage, an amount, or
 * both, plus the currency an amount is stated in, the reset instant, when the
 * observation was taken and whether the service considers it stale. This module
 * is the only place that shape becomes something the dashboard can draw, and it
 * splits the rows exactly the way the contract does:
 *
 *   a row with a percentage becomes an engine snapshot, so the phone renders it
 *   through the same bar, the same bands and the same stale hatch the desktop
 *   and the browser dashboard already use;
 *
 *   a row with only money, which is a spend meter or one of the three balance
 *   components, stays money. The engine's amount fields describe a credit plan
 *   as spent out of loaded, in one currency, and a balance is neither of those,
 *   so forcing it through them would print a number that is not true.
 *
 * Nothing here invents a value. A row that fails validation is dropped and the
 * rest are unaffected, which is the same rule every parser in this product
 * keeps.
 */

const PROVIDER_PATTERN = /^[A-Z0-9_]{2,32}$/u;
const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CODE_PATTERN = /^[A-Z0-9_]{2,48}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

/** How long a fresh phone reading stays fresh on screen. */
export const DEVICE_FRESH_MILLISECONDS = 5 * 60_000;

export interface MeterRow {
  accountId: string;
  provider: string;
  code: string;
  percent: number | null;
  amount: number | null;
  currency: string | null;
  resetsAt: string | null;
  observedAt: string;
  stale: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function instant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function bounded(value: unknown, max: number): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < max ? parsed : null;
}

/** One row, or null when it does not satisfy the contract. */
export function meterRowOf(value: unknown): MeterRow | null {
  const row = record(value);
  if (row === null) return null;
  const accountId = typeof row.account_id === "string" ? row.account_id : "";
  const provider = typeof row.provider === "string" ? row.provider : "";
  const code = typeof row.code === "string" ? row.code : "";
  const observedAt = instant(row.observed_at);
  const percent = bounded(row.percent, 100_001);
  const amount = bounded(row.amount, 1e14);
  const currency = typeof row.currency === "string" ? row.currency : null;
  if (
    !ACCOUNT_PATTERN.test(accountId) ||
    !PROVIDER_PATTERN.test(provider) ||
    !CODE_PATTERN.test(code) ||
    observedAt === null ||
    (percent === null && amount === null) ||
    (amount === null) !== (currency === null) ||
    (currency !== null && !CURRENCY_PATTERN.test(currency))
  ) {
    return null;
  }
  return {
    accountId,
    provider,
    code,
    percent,
    amount,
    currency,
    resetsAt: instant(row.resets_at),
    observedAt,
    stale: row.stale === true,
  };
}

/** Every row in a `read_snapshots` response that survives validation. */
export function meterRowsOf(value: unknown): MeterRow[] {
  const body = record(value);
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  const parsed: MeterRow[] = [];
  for (const row of rows) {
    const meter = meterRowOf(row);
    if (meter !== null) parsed.push(meter);
  }
  return parsed;
}

/** Whether a row belongs on a percentage bar. */
export function isPercentRow(row: MeterRow, providers: readonly string[]): boolean {
  return row.percent !== null && providers.includes(row.provider);
}

/** The money only rows, in the order they read: spend first, balance after. */
export function amountRows(row: readonly MeterRow[], providers: readonly string[]): MeterRow[] {
  return row
    .filter((meter) => !isPercentRow(meter, providers))
    .sort(
      (left, right) =>
        left.provider.localeCompare(right.provider) || left.code.localeCompare(right.code),
    );
}

/**
 * A percentage row as the engine's own snapshot shape.
 *
 * The expiry is what makes the bar hatch: a row the service marked stale is
 * given an expiry equal to its own observation, so the freshness rule reads it
 * as stale without any surface having to special case it.
 */
export function snapshotFromMeterRow(row: MeterRow): Record<string, unknown> | null {
  if (row.percent === null) return null;
  const observed = Date.parse(row.observedAt);
  const expires = row.stale ? observed : observed + DEVICE_FRESH_MILLISECONDS;
  return {
    provider: row.provider,
    meter: row.code,
    value: row.percent,
    unit: "PERCENT",
    window: { kind: "rolling" },
    resetAt: row.resetsAt,
    source: "documented_api",
    precision: "exact",
    observedAt: row.observedAt,
    expiresAt: new Date(expires).toISOString(),
    accountId: row.accountId,
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "documented-api",
      automationRisk: "low",
      verification: "UNVERIFIED",
    },
    provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
  };
}

/** An amount with its currency, formatted for the locale that is reading. */
export function formatAmount(row: MeterRow, locale: string): string | null {
  if (row.amount === null || row.currency === null) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: row.currency,
      maximumFractionDigits: 2,
    }).format(row.amount);
  } catch {
    return `${row.amount.toFixed(2)} ${row.currency}`;
  }
}
