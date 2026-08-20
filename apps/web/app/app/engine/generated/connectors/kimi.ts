/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
// This interface is UNOFFICIAL and may break.
import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "../core";
import {
  futureInstantFromRfc3339,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry
} from "./shared";

export const kimiLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const kimiEncoding = "json" as const;

function numeric(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= 1_000_000_000_000
    ? parsed
    : null;
}

function quota(
  value: unknown,
  now: string,
  horizon: number
): { percent: number; resetAt: string } | null {
  const detail = record(value);
  if (detail === null) return null;
  const used = numeric(detail["used"]);
  const limit = numeric(detail["limit"]);
  if (used === null || limit === null || limit <= 0 || used > limit) return null;
  const resetAt = futureInstantFromRfc3339(
    detail["resetTime"],
    now,
    plausibleResetHorizon(horizon)
  );
  if (resetAt === null) return null;
  return { percent: used / limit * 100, resetAt };
}

function durationSeconds(value: unknown): number | null {
  const window = record(value);
  if (window === null) return null;
  const duration = window["duration"];
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration <= 0) {
    return null;
  }
  const multiplier = {
    TIME_UNIT_MINUTE: 60,
    TIME_UNIT_HOUR: 3_600,
    TIME_UNIT_DAY: 86_400,
    TIME_UNIT_WEEK: 604_800
  }[String(window["timeUnit"] ?? "")];
  if (multiplier === undefined) return null;
  const seconds = duration * multiplier;
  return Number.isSafeInteger(seconds) && seconds <= 31_536_000 ? seconds : null;
}

function meterName(seconds: number, ordinal: number): string | null {
  const base = seconds === 300
    ? "FIVE_MINUTE"
    : seconds === 18_000
      ? "FIVE_HOUR"
      : seconds === 86_400
        ? "DAILY"
        : seconds === 604_800
          ? "SEVEN_DAY"
          : `WINDOW_${seconds}`;
  const meter = ordinal === 1 ? base : `${base}_${ordinal}`;
  return /^[A-Z][A-Z0-9_]{0,31}$/u.test(meter) ? meter : null;
}

export function parseKimiPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null) return null;
  const weekly = quota(root["usage"], now, 604_800);
  if (weekly === null) return null;
  const meters: RawMeter[] = [rawMeter({
    provider: "KIMI",
    meter: "WEEKLY",
    value: weekly.percent,
    window: { kind: "rolling", durationSeconds: 604_800 },
    resetAt: weekly.resetAt,
    source: "internal_payload",
    precision: "estimated",
    observedAt: now,
    expiresAt,
    labels: kimiLabels
  })];
  const limits = root["limits"];
  if (limits !== undefined && !Array.isArray(limits)) return null;
  const ordinals = new Map<number, number>();
  for (const entryValue of Array.isArray(limits) ? limits : []) {
    const entry = record(entryValue);
    if (entry === null) return null;
    const detail = record(entry["detail"]);
    if (detail === null) continue;
    const hasQuota = ["used", "limit", "resetTime"].some((field) => field in detail);
    if (!hasQuota) continue;
    const seconds = durationSeconds(entry["window"]);
    if (seconds === null) return null;
    const reading = quota(detail, now, seconds);
    if (reading === null) return null;
    const ordinal = (ordinals.get(seconds) ?? 0) + 1;
    ordinals.set(seconds, ordinal);
    const meter = meterName(seconds, ordinal);
    if (meter === null) return null;
    meters.push(rawMeter({
      provider: "KIMI",
      meter,
      value: reading.percent,
      window: { kind: "rolling", durationSeconds: seconds },
      resetAt: reading.resetAt,
      source: "internal_payload",
      precision: "estimated",
      observedAt: now,
      expiresAt,
      labels: kimiLabels
    }));
  }
  return meters;
}

export const kimiConnector: ConnectorContract = {
  id: "kimi",
  displayName: "Kimi",
  encoding: kimiEncoding,
  labels: kimiLabels,
  detect(environment) {
    return environment["KIMI_USAGE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseKimiPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
