// This interface is UNOFFICIAL and may break.
import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter,
  SnapshotWindow
} from "@openlimiter/core";
import {
  boundedNumber,
  futureInstantFromRfc3339,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry
} from "./shared.js";

export const grokLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const grokEncoding = "json" as const;

function objectValue(value: unknown): number | null {
  const object = record(value);
  if (object === null) return null;
  const raw = object["val"];
  const number = typeof raw === "string" ? Number(raw) : raw;
  return typeof number === "number" &&
    Number.isFinite(number) &&
    number >= 0 &&
    number <= 1_000_000_000_000
    ? number
    : null;
}

function percentage(used: number, limit: number): number | null {
  if (limit <= 0 || used > limit) return null;
  const value = used / limit * 100;
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function currentPeriod(
  config: Record<string, unknown>,
  now: string
): { meter: string; window: SnapshotWindow; resetAt: string } | null {
  const period = record(config["currentPeriod"]);
  if (period === null) return null;
  const type = period["type"];
  const weekly = type === "USAGE_PERIOD_TYPE_WEEKLY";
  const monthly = type === "USAGE_PERIOD_TYPE_MONTHLY";
  if (!weekly && !monthly) return null;
  const durationSeconds = weekly ? 604_800 : undefined;
  const resetAt = futureInstantFromRfc3339(
    period["end"],
    now,
    plausibleResetHorizon(durationSeconds ?? 2_678_400)
  );
  if (resetAt === null) return null;
  return {
    meter: weekly ? "WEEKLY" : "MONTHLY",
    window: durationSeconds === undefined
      ? { kind: "fixed" }
      : { kind: "fixed", durationSeconds },
    resetAt
  };
}

export function parseGrokPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const config = record(root?.["config"]);
  const expiresAt = shortExpiry(now);
  if (config === null || expiresAt === null) return null;
  const meters: RawMeter[] = [];
  const stated = boundedNumber(config["creditUsagePercent"]);
  if (stated !== null) {
    const period = currentPeriod(config, now);
    if (period === null) return null;
    meters.push(rawMeter({
      provider: "GROK",
      meter: period.meter,
      value: stated,
      window: period.window,
      resetAt: period.resetAt,
      source: "internal_payload",
      precision: "estimated",
      observedAt: now,
      expiresAt,
      labels: grokLabels
    }));
  } else {
    const limit = objectValue(config["monthlyLimit"]);
    const used = objectValue(config["used"]);
    if (limit === null || used === null) return null;
    const value = percentage(used, limit);
    if (value === null) return null;
    const resetAt = config["billingPeriodEnd"] === undefined
      ? null
      : futureInstantFromRfc3339(
          config["billingPeriodEnd"],
          now,
          plausibleResetHorizon(2_678_400)
        );
    if (config["billingPeriodEnd"] !== undefined && resetAt === null) return null;
    meters.push(rawMeter({
      provider: "GROK",
      meter: "MONTHLY",
      value,
      window: { kind: "fixed" },
      resetAt,
      source: "internal_payload",
      precision: "estimated",
      observedAt: now,
      expiresAt,
      labels: grokLabels
    }));
  }
  const cap = objectValue(config["onDemandCap"]);
  const used = objectValue(config["onDemandUsed"]);
  if (cap === null && used === null) return meters;
  if (cap === 0 && used === 0) return meters;
  if (cap === null || used === null) return null;
  const value = percentage(used, cap);
  if (value === null) return null;
  meters.push(rawMeter({
    provider: "GROK",
    meter: "ON_DEMAND_MONTHLY",
    value,
    window: { kind: "fixed" },
    resetAt: null,
    source: "internal_payload",
    precision: "estimated",
    observedAt: now,
    expiresAt,
    labels: grokLabels
  }));
  return meters;
}

export const grokConnector: ConnectorContract = {
  id: "grok",
  displayName: "Grok",
  encoding: grokEncoding,
  labels: grokLabels,
  detect(environment) {
    return environment["GROK_USAGE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseGrokPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
