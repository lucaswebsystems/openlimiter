// These interfaces are UNOFFICIAL and may break.
import type {
  ConnectionTool,
  ConnectorContract,
  ConnectorLabels,
  ConnectorMaturity,
  ConnectorResult,
  ProviderCode,
  RawMeter,
  SnapshotWindow
} from "@openlimiter/core";
import {
  connectorConnection,
  futureInstantFromEpochSeconds,
  futureInstantFromRfc3339,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry
} from "./shared.js";

/**
 * The readers for four tools whose saved sign in the desktop app reads on its
 * own: Hermes (Nous Portal), Command Code, Cline and Kilo Code. Each reply is
 * one undocumented endpoint's JSON; the field names come from each tool's own
 * source, recorded beside every parser. The Rust twins live in
 * apps/desktop/src-tauri/src/native_readers.rs and both read the same shared
 * cases under packages/connectors/fixtures/cases.
 */

export const toolLoginLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

/** EXPERIMENTAL: every endpoint here is undocumented and nobody promised its shape. */
export const toolLoginMaturity = "experimental" as const satisfies ConnectorMaturity;

/** Largest money balance a reading may carry, the cache's own bound. */
const MAX_BALANCE = 1_000_000;
const MONTH_SECONDS = 2_592_000;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function percentMeter(
  provider: ProviderCode,
  meter: string,
  value: number,
  window: SnapshotWindow,
  resetAt: string | null,
  now: string,
  expiresAt: string
): RawMeter {
  return rawMeter({
    provider,
    meter,
    value,
    window,
    resetAt,
    source: "internal_payload",
    precision: "exact",
    observedAt: now,
    expiresAt,
    labels: toolLoginLabels
  });
}

/**
 * Money left, stated in US dollars by the tool itself, with no total beside it.
 * The currency travels on the row, so every surface and the account sync print
 * it as money without guessing.
 */
function balanceMeter(
  provider: ProviderCode,
  value: number,
  now: string,
  expiresAt: string
): RawMeter | null {
  if (!Number.isFinite(value) || value < 0 || value > MAX_BALANCE) return null;
  return {
    provider,
    meter: "BALANCE",
    value,
    unit: "CREDITS",
    kind: "money_balance",
    currency: "USD",
    window: { kind: "lifetime" },
    resetAt: null,
    source: "internal_payload",
    precision: "exact",
    observedAt: now,
    expiresAt,
    labels: toolLoginLabels
  };
}

/**
 * Hermes's Nous Portal account (`hermes_cli/nous_account.py`, the gauge in
 * `agent/account_usage.py`): the month's subscription credits used, from
 * `subscription.monthly_credits` and `subscription.credits_remaining`, reset at
 * `subscription.current_period_end`; and the purchased credits left,
 * `paid_service_access.purchased_credits_remaining`, zero included. A
 * remainder above the allowance (rollover) draws no percentage, as in Hermes.
 */
export function parseHermesPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null) return null;
  const meters: RawMeter[] = [];
  const subscription = record(root["subscription"]);
  if (subscription !== null) {
    const cap = finite(subscription["monthly_credits"]);
    const remaining = finite(subscription["credits_remaining"]);
    if (cap !== null && cap > 0 && remaining !== null && remaining <= cap) {
      const percent = Math.min(100, Math.max(0, (cap - remaining) / cap * 100));
      meters.push(percentMeter(
        "HERMES",
        "MONTHLY",
        percent,
        { kind: "fixed", durationSeconds: MONTH_SECONDS },
        futureInstantFromRfc3339(subscription["current_period_end"], now, plausibleResetHorizon(MONTH_SECONDS)),
        now,
        expiresAt
      ));
    }
  }
  const purchased = finite(record(root["paid_service_access"])?.["purchased_credits_remaining"]);
  if (purchased !== null) {
    const balance = balanceMeter("HERMES", purchased, now, expiresAt);
    if (balance !== null) meters.push(balance);
  }
  return meters.length === 0 ? null : meters;
}

/** A window reset stated as epoch milliseconds, as the CLI compares it, or seconds. */
function epochReset(value: unknown, now: string, windowSeconds: number): string | null {
  const stated = finite(value);
  if (stated === null) return null;
  const seconds = stated >= 1_000_000_000_000 ? stated / 1_000 : stated;
  return futureInstantFromEpochSeconds(seconds, now, plausibleResetHorizon(windowSeconds));
}

/**
 * Command Code's credits (`projectUsageView` and `WindowLimitMeter` in the
 * command-code bundle): `windowLimits.fiveHour` and `windowLimits.weekly` as
 * `used` of `cap` with `resetAt`, and the credits left, monthly plus purchased
 * plus free, as one balance. A reply wrapped in `data` is read inside it.
 */
export function parseCommandcodePayload(payload: unknown, now: string): RawMeter[] | null {
  const outer = record(payload);
  const root = record(outer?.["data"]) ?? outer;
  const credits = record(root?.["credits"]);
  const expiresAt = shortExpiry(now);
  if (root === null || credits === null || expiresAt === null) return null;
  const parts = ["monthlyCredits", "purchasedCredits", "freeCredits"]
    .map((name) => finite(credits[name]))
    .filter((part): part is number => part !== null);
  if (parts.length === 0) return null;
  const meters: RawMeter[] = [];
  const windows = record(root["windowLimits"]);
  for (const [name, meter, seconds] of [
    ["fiveHour", "FIVE_HOUR", 18_000],
    ["weekly", "SEVEN_DAY", 604_800]
  ] as const) {
    const window = record(windows?.[name]);
    if (window === null) continue;
    const cap = finite(window["cap"]);
    const used = finite(window["used"]);
    if (cap === null || cap <= 0 || used === null || used < 0) continue;
    meters.push(percentMeter(
      "COMMANDCODE",
      meter,
      Math.min(100, used / cap * 100),
      { kind: "rolling", durationSeconds: seconds },
      epochReset(window["resetAt"], now, seconds),
      now,
      expiresAt
    ));
  }
  const total = parts.reduce((sum, part) => sum + Math.max(0, part), 0);
  const balance = balanceMeter("COMMANDCODE", total, now, expiresAt);
  if (balance === null) return null;
  meters.push(balance);
  return meters;
}

/**
 * ClinePass's limits (CodexBar `clinepass.ts`, oh-my-pi `cline-pass.ts`):
 * `{"success": true, "data": {"limits": [{"type", "percentUsed", "resetsAt"}]}}`,
 * of which `five_hour`, `weekly` and `monthly` are read. An unknown type is
 * skipped; a known one without a numeric percentage costs the whole reply.
 */
export function parseClinePayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null || root["success"] !== true) return null;
  const limits = record(root["data"])?.["limits"];
  if (!Array.isArray(limits)) return null;
  const types: Readonly<Record<string, readonly [string, number]>> = {
    five_hour: ["FIVE_HOUR", 18_000],
    weekly: ["SEVEN_DAY", 604_800],
    monthly: ["MONTHLY", MONTH_SECONDS]
  };
  const meters: RawMeter[] = [];
  for (const entry of limits) {
    const limit = record(entry);
    if (limit === null || typeof limit["type"] !== "string") return null;
    const known = Object.hasOwn(types, limit["type"]) ? types[limit["type"]] : undefined;
    if (known === undefined) continue;
    const [meter, seconds] = known;
    const percent = finite(limit["percentUsed"]);
    if (percent === null) return null;
    const stated = limit["resetsAt"];
    if (stated !== undefined && stated !== null && typeof stated !== "string") return null;
    if (meters.some((row) => row.meter === meter)) continue;
    meters.push(percentMeter(
      "CLINE",
      meter,
      Math.min(100, Math.max(0, percent)),
      { kind: "rolling", durationSeconds: seconds },
      futureInstantFromRfc3339(stated, now, plausibleResetHorizon(seconds)),
      now,
      expiresAt
    ));
  }
  return meters.length === 0 ? null : meters;
}

/**
 * Kilo Code's balance (`fetchBalance` in `packages/kilo-gateway`):
 * `{"balance": <dollars>}`. A missing balance is not read as zero.
 */
export function parseKilocodePayload(payload: unknown, now: string): RawMeter[] | null {
  const balance = finite(record(payload)?.["balance"]);
  const expiresAt = shortExpiry(now);
  if (balance === null || expiresAt === null) return null;
  const meter = balanceMeter("KILOCODE", balance, now, expiresAt);
  return meter === null ? null : [meter];
}

function toolConnector(
  id: ConnectorContract["id"],
  displayName: string,
  tool: ConnectionTool,
  parse: (payload: unknown, now: string) => RawMeter[] | null
): ConnectorContract {
  return {
    id,
    displayName,
    encoding: "json",
    maturity: toolLoginMaturity,
    labels: toolLoginLabels,
    /* Read by the desktop app from the tool's own saved sign in; a terminal
       has no reader of its own for these yet. */
    detect: () => false,
    async read(context): Promise<ConnectorResult> {
      const meters = parse(context.payload, context.now);
      const connection = connectorConnection(meters !== null, context.payload, tool);
      return meters === null
        ? { ok: false, reason: "unknown", connection }
        : { ok: true, meters, connection };
    }
  };
}

export const hermesConnector = toolConnector("hermes", "Hermes", "Hermes", parseHermesPayload);
export const commandcodeConnector = toolConnector(
  "commandcode",
  "Command Code",
  "Command Code",
  parseCommandcodePayload
);
export const clineConnector = toolConnector("cline", "Cline", "Cline", parseClinePayload);
export const kilocodeConnector = toolConnector("kilocode", "Kilo Code", "Kilo Code", parseKilocodePayload);
