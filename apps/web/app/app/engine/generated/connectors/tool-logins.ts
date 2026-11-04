/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
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
} from "../core";
import {
  connectorConnection,
  futureInstantFromEpochSeconds,
  futureInstantFromRfc3339,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry
} from "./shared";

/**
 * The readers for nine tools whose saved sign in the desktop app reads on its
 * own: Hermes (Nous Portal), Command Code, Cline, Kilo Code, GitHub Copilot,
 * Amp, Codebuff, Kiro and Crush (Charm Hyper). Each reply is one undocumented
 * endpoint's JSON; the field names come from each tool's own source, or the
 * meter that reads it, recorded beside every parser. The Rust twins live in
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

/** Credits left in the tool's own unit, not money: no kind, no currency. */
function creditsMeter(
  provider: ProviderCode,
  value: number,
  now: string,
  expiresAt: string
): RawMeter | null {
  const meter = balanceMeter(provider, value, now, expiresAt);
  if (meter === null) return null;
  const { kind: _money, currency: _currency, ...credits } = meter;
  return credits;
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

/**
 * One Copilot quota snapshot as a percentage used, or null when it draws no
 * bar: unlimited, a zero entitlement placeholder, or no usable percentage.
 * `percent_remaining` is preferred; without it, `remaining` of `entitlement`
 * (CodexBar `CopilotUsageModels.swift`).
 */
function copilotUsedPercent(snapshot: Record<string, unknown>): number | null {
  if (snapshot["unlimited"] === true) return null;
  const entitlement = finite(snapshot["entitlement"]);
  const remaining = finite(snapshot["remaining"]);
  if (entitlement === 0 && remaining === 0) return null;
  const stated = finite(snapshot["percent_remaining"]);
  const percentRemaining = stated ?? (
    entitlement !== null && remaining !== null && entitlement > 0 ? remaining / entitlement * 100 : null
  );
  if (percentRemaining === null) return null;
  return Math.min(100, Math.max(0, 100 - percentRemaining));
}

/** A reset stated as a calendar date (`2026-09-01`) or an RFC3339 instant. */
function dateOrInstant(value: unknown, now: string, maxAheadSeconds: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const stated = /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text + "T00:00:00Z" : text;
  return futureInstantFromRfc3339(stated, now, maxAheadSeconds);
}

/**
 * GitHub Copilot's own quota report (CodexBar `CopilotUsageFetcher.swift` and
 * `CopilotUsageModels.swift`): `quota_snapshots.premium_interactions` and
 * `quota_snapshots.chat`, each used percent = 100 minus `percent_remaining`,
 * reset at `quota_reset_date`. An unlimited snapshot draws no bar; an ended
 * subscription and a reply with no bar are not read.
 */
export function parseCopilotPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null) return null;
  if (root["access_type_sku"] === "subscription_ended") return null;
  const snapshots = record(root["quota_snapshots"]);
  if (snapshots === null) return null;
  const resetAt = dateOrInstant(root["quota_reset_date"], now, plausibleResetHorizon(MONTH_SECONDS));
  const meters: RawMeter[] = [];
  for (const [name, meter] of [["premium_interactions", "PREMIUM"], ["chat", "CHAT"]] as const) {
    const snapshot = record(snapshots[name]);
    const percent = snapshot === null ? null : copilotUsedPercent(snapshot);
    if (percent === null) continue;
    meters.push(percentMeter(
      "COPILOT",
      meter,
      percent,
      { kind: "fixed", durationSeconds: MONTH_SECONDS },
      resetAt,
      now,
      expiresAt
    ));
  }
  return meters.length === 0 ? null : meters;
}

/** A dollar amount as the Amp CLI prints it: digits, thousands commas, decimals. */
function ampAmount(text: string | undefined): number | null {
  if (text === undefined) return null;
  const value = Number(text.replace(/,/gu, ""));
  return Number.isFinite(value) ? value : null;
}

const AMP_AMOUNT = "([0-9][0-9,]*(?:\\.[0-9]+)?)";
const AMP_ANSI = /\x1b\[[0-9;]*[A-Za-z]/gu;
const AMP_FREE = new RegExp(
  "^[ \\t]*Amp Free:[ \\t]*\\$?" + AMP_AMOUNT + "[ \\t]*/[ \\t]*\\$?" + AMP_AMOUNT + "[ \\t]+remaining",
  "imu"
);
const AMP_FREE_PERCENT = new RegExp("^[ \\t]*Amp Free:[ \\t]*" + AMP_AMOUNT + "[ \\t]*%[ \\t]+remaining", "imu");
const AMP_CREDITS = new RegExp("^[ \\t]*Individual credits:[ \\t]*\\$?" + AMP_AMOUNT + "[ \\t]+remaining", "imu");

/**
 * Amp's balance procedure (`amp usage` in the Amp CLI bundle, the patterns
 * CodexBar's `AmpUsageParser.swift` reads): `{"ok": true, "result":
 * {"displayText"}}`, a text whose lines state "Amp Free: $R / $Q remaining"
 * (or "Amp Free: N% remaining") and "Individual credits: $N remaining". The
 * free allowance is drawn as a percentage used, the credits as dollars left.
 * Subscription and workspace lines are not read.
 */
export function parseAmpPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null || root["ok"] !== true) return null;
  const shown = record(root["result"])?.["displayText"];
  if (typeof shown !== "string") return null;
  const text = shown.replace(AMP_ANSI, "").split("**").join("");
  const meters: RawMeter[] = [];
  const free = AMP_FREE.exec(text);
  let used: number | null = null;
  if (free !== null) {
    const remaining = ampAmount(free[1]);
    const quota = ampAmount(free[2]);
    if (remaining !== null && quota !== null && quota > 0) used = (quota - remaining) / quota * 100;
  }
  if (used === null) {
    const percent = AMP_FREE_PERCENT.exec(text);
    const remaining = percent === null ? null : ampAmount(percent[1]);
    if (remaining !== null) used = 100 - remaining;
  }
  if (used !== null) {
    meters.push(percentMeter(
      "AMP",
      "FREE",
      Math.min(100, Math.max(0, used)),
      /* The allowance replenishes by the hour up to a day's worth. */
      { kind: "rolling", durationSeconds: 86_400 },
      null,
      now,
      expiresAt
    ));
  }
  const credits = AMP_CREDITS.exec(text);
  const dollars = credits === null ? null : ampAmount(credits[1]);
  const balance = dollars === null ? null : balanceMeter("AMP", dollars, now, expiresAt);
  if (balance !== null) meters.push(balance);
  return meters.length === 0 ? null : meters;
}

/**
 * Codebuff's usage reply (`fetchUsageData` in the Codebuff CLI):
 * `{"type": "usage-response", "usage", "remainingBalance", ...}`. The remaining
 * balance is Codebuff credits, not money, drawn as credits left. A null balance
 * is not read as zero.
 */
export function parseCodebuffPayload(payload: unknown, now: string): RawMeter[] | null {
  const balance = finite(record(payload)?.["remainingBalance"]);
  const expiresAt = shortExpiry(now);
  if (balance === null || expiresAt === null) return null;
  const meter = creditsMeter("CODEBUFF", balance, now, expiresAt);
  return meter === null ? null : [meter];
}

/**
 * Codebuff's subscription reply (`SubscriptionResponse` in
 * `common/src/types/subscription.ts`): with `hasSubscription` true,
 * `rateLimit.weeklyUsed` of `rateLimit.weeklyLimit`, reset at
 * `rateLimit.weeklyResetsAt`. No subscription is no weekly bar, not an error.
 */
export function parseCodebuffSubscriptionPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null || typeof root["hasSubscription"] !== "boolean") return null;
  if (!root["hasSubscription"]) return [];
  const limit = record(root["rateLimit"]);
  const cap = finite(limit?.["weeklyLimit"]);
  const used = finite(limit?.["weeklyUsed"]);
  if (limit === null || cap === null || cap <= 0 || used === null || used < 0) return null;
  return [percentMeter(
    "CODEBUFF",
    "SEVEN_DAY",
    Math.min(100, used / cap * 100),
    { kind: "rolling", durationSeconds: 604_800 },
    futureInstantFromRfc3339(limit["weeklyResetsAt"], now, plausibleResetHorizon(604_800)),
    now,
    expiresAt
  )];
}

/**
 * Kiro's usage limits (CodexBar `KiroUsageLimitsAPI.swift`): the one
 * `usageBreakdownList` entry whose `resourceType` is `CREDIT`, plan credits used
 * (`currentUsageWithPrecision` less `currentOveragesWithPrecision`) of
 * `usageLimitWithPrecision`, reset at `nextDateReset` in epoch seconds. Two
 * credit entries, a negative part or an overage above the total is not read.
 */
export function parseKiroPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const expiresAt = shortExpiry(now);
  const list = root?.["usageBreakdownList"];
  if (root === null || expiresAt === null || !Array.isArray(list)) return null;
  const credits = list
    .map((entry) => record(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null && entry["resourceType"] === "CREDIT");
  if (credits.length !== 1) return null;
  const credit = credits[0]!;
  const limit = finite(credit["usageLimitWithPrecision"]);
  const total = finite(credit["currentUsageWithPrecision"]);
  if (limit === null || limit <= 0 || total === null || total < 0) return null;
  const statedOverage = credit["currentOveragesWithPrecision"];
  const overage = statedOverage === undefined || statedOverage === null ? 0 : finite(statedOverage);
  if (overage === null || overage < 0 || overage > total) return null;
  const reset = finite(credit["nextDateReset"]) ?? finite(root["nextDateReset"]);
  return [percentMeter(
    "KIRO",
    "MONTHLY",
    Math.min(100, Math.max(0, (total - overage) / limit * 100)),
    { kind: "fixed", durationSeconds: MONTH_SECONDS },
    reset === null ? null : futureInstantFromEpochSeconds(reset, now, plausibleResetHorizon(MONTH_SECONDS)),
    now,
    expiresAt
  )];
}

/**
 * Charm Hyper's credits (`FetchCredits` in Crush): `{"balance"}` in Hyper
 * credits, drawn as credits left; a team that shows dollars instead states
 * `balance_usd`, drawn as money left. Neither is read as zero when absent.
 */
export function parseCrushPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null) return null;
  const credits = finite(root["balance"]);
  if (credits !== null) {
    const meter = creditsMeter("CRUSH", credits, now, expiresAt);
    return meter === null ? null : [meter];
  }
  const dollars = finite(root["balance_usd"]);
  const meter = dollars === null ? null : balanceMeter("CRUSH", dollars, now, expiresAt);
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
export const copilotConnector = toolConnector("copilot", "GitHub Copilot", "GitHub Copilot", parseCopilotPayload);
export const ampConnector = toolConnector("amp", "Amp", "Amp", parseAmpPayload);
export const codebuffConnector = toolConnector("codebuff", "Codebuff", "Codebuff", parseCodebuffPayload);
export const kiroConnector = toolConnector("kiro", "Kiro", "Kiro", parseKiroPayload);
export const crushConnector = toolConnector("crush", "Crush", "Crush", parseCrushPayload);
