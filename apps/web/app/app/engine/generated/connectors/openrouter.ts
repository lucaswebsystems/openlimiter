/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import type {
  ConnectionTool,
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "../core";
import {
  boundedNumber,
  connectorConnection,
  rawMeter,
  record,
  shortExpiry
} from "./shared";

export const openrouterLabels = {
  credentialOrigin: "user-key",
  dataInterfaceStatus: "documented-api",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const openrouterCredential = {
  store: "operating_system",
  service: "openlimiter",
  account: "openrouter",
  repositoryPath: null,
  readMode: "read_only"
} as const;

function finiteLimitWindow(limitReset: unknown, now: string): {
  window: { kind: "fixed"; durationSeconds: number } | { kind: "lifetime" };
  resetAt: string | null;
} | null {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return null;
  if (limitReset === null || limitReset === undefined) {
    return { window: { kind: "lifetime" }, resetAt: null };
  }
  if (typeof limitReset !== "string" || !["daily", "weekly", "monthly"].includes(limitReset)) return null;
  const date = new Date(current);
  let reset: Date;
  if (limitReset === "daily") {
    reset = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  } else if (limitReset === "weekly") {
    const daysUntilMonday = ((8 - date.getUTCDay()) % 7) || 7;
    reset = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + daysUntilMonday));
  } else {
    reset = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }
  const seconds = Math.ceil((reset.getTime() - current) / 1_000);
  return seconds > 0 && Number.isFinite(seconds)
    ? { window: { kind: "fixed", durationSeconds: seconds }, resetAt: reset.toISOString() }
    : null;
}

function roundedAmount(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function unavailableAccountBalance(now: string, expiresAt: string): RawMeter {
  return {
    provider: "OPENROUTER",
    meter: "ACCOUNT_BALANCE",
    availability: "missing_credentials",
    value: 0,
    unit: "PERCENT",
    window: { kind: "lifetime" },
    resetAt: null,
    source: "documented_api",
    precision: "exact",
    observedAt: now,
    expiresAt,
    labels: openrouterLabels,
  };
}

export function parseOpenrouterPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const data = record(root?.["data"]);
  if (data === null) return null;
  const keyResponse = !("total_credits" in data || "total_usage" in data);
  const credits = boundedNumber(data[keyResponse ? "limit" : "total_credits"], 1_000_000_000_000);
  const usage = boundedNumber(data[keyResponse ? "usage" : "total_usage"], 1_000_000_000_000);
  const expiresAt = shortExpiry(now);
  if (keyResponse && data["limit"] === null) {
    if (usage === null || expiresAt === null) return null;
    return [{
      provider: "OPENROUTER",
      meter: "KEY_LIMIT",
      availability: "unlimited",
      // Required legacy transport fields; availability carries no percentage.
      value: 0,
      unit: "PERCENT",
      window: { kind: "lifetime" },
      resetAt: null,
      source: "documented_api",
      precision: "exact",
      observedAt: now,
      expiresAt,
      labels: openrouterLabels
    }, unavailableAccountBalance(now, expiresAt)];
  }
  if (keyResponse) {
    const remaining = boundedNumber(data["limit_remaining"], 1_000_000_000_000);
    const reset = finiteLimitWindow(data["limit_reset"], now);
    if (credits === null || remaining === null || usage === null || credits <= 0 || remaining > credits || reset === null || expiresAt === null) return null;
    const used = roundedAmount(credits - remaining);
    const percent = roundedAmount((used / credits) * 100);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
    return [rawMeter({
      provider: "OPENROUTER",
      meter: "KEY_LIMIT",
      value: percent,
      window: reset.window,
      resetAt: reset.resetAt,
      source: "documented_api",
      precision: "exact",
      observedAt: now,
      expiresAt,
      labels: openrouterLabels,
      amounts: { usedAmount: used, limitAmount: credits, currency: "USD" }
    }), unavailableAccountBalance(now, expiresAt)];
  }
  if (
    credits === null ||
    usage === null ||
    credits <= 0 ||
    usage > credits ||
    expiresAt === null
  ) return null;
  const percent = (usage / credits) * 100;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  /*
   * The management credits endpoint states lifetime money: total_credits is
   * what the plan holds and total_usage is what has been spent out of it.
   * The normalizer decides whether the figures are believable.
   */
  return [rawMeter({
    provider: "OPENROUTER",
    meter: "ACCOUNT_BALANCE",
    value: percent,
    window: { kind: "lifetime" },
    resetAt: null,
    source: "documented_api",
    precision: "exact",
    observedAt: now,
    expiresAt,
    labels: openrouterLabels,
    amounts: { usedAmount: usage, limitAmount: credits, currency: "USD" }
  })];
}

/** No local application owns this key, so no instruction names one. */
export const OPENROUTER_TOOL: ConnectionTool = null;

export const openrouterConnector: ConnectorContract = {
  id: "openrouter",
  encoding: "json",
  displayName: "OpenRouter",
  labels: openrouterLabels,
  detect(environment) {
    return environment["OPENLIMITER_OPENROUTER_CREDENTIAL"] === "available";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseOpenrouterPayload(context.payload, context.now);
    const connection = connectorConnection(
      meters !== null,
      context.payload,
      OPENROUTER_TOOL
    );
    return meters === null
      ? { ok: false, reason: "unknown", connection }
      : { ok: true, meters, connection };
  }
};
