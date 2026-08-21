// This interface is UNOFFICIAL and may break.
import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import {
  boundedFraction,
  futureInstantFromRfc3339,
  rawMeter,
  record,
  shortExpiry
} from "./shared.js";

export const geminiCliLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const geminiCliEncoding = "json" as const;

const MAX_MODEL_ID_BYTES = 128;
const MAX_RESET_HORIZON_SECONDS = 2_678_400 + 3_600;

function meterFromModel(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MODEL_ID_BYTES ||
    !/^[\x00-\x7F]+$/u.test(value) ||
    !/^[A-Za-z0-9._-]+$/u.test(value)
  ) return null;
  const meter = value
    .toUpperCase()
    .replace(/[._-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return /^[A-Z][A-Z0-9_]{0,31}$/u.test(meter) ? meter : null;
}

function validTokenType(value: unknown): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32 &&
    /^[A-Z_]+$/u.test(value);
}

export function parseGeminiCliPayload(
  payload: unknown,
  now: string
): RawMeter[] | null {
  const root = record(payload);
  const buckets = root?.["buckets"];
  const expiresAt = shortExpiry(now);
  if (!Array.isArray(buckets) || buckets.length === 0 || expiresAt === null) return null;
  const seen = new Set<string>();
  const meters: RawMeter[] = [];
  for (const value of buckets) {
    const bucket = record(value);
    if (bucket === null) return null;
    const meter = meterFromModel(bucket["modelId"]);
    if (meter === null || seen.has(meter)) return null;
    seen.add(meter);
    if (bucket["tokenType"] !== undefined && !validTokenType(bucket["tokenType"])) {
      return null;
    }
    const remaining = boundedFraction(bucket["remainingFraction"]);
    const resetAt = futureInstantFromRfc3339(
      bucket["resetTime"],
      now,
      MAX_RESET_HORIZON_SECONDS
    );
    if (remaining === null || resetAt === null) return null;
    meters.push(rawMeter({
      provider: "GEMINI_CLI",
      meter,
      value: Math.round((1 - remaining) * 1_000) / 10,
      window: { kind: "fixed" },
      resetAt,
      source: "internal_payload",
      precision: "estimated",
      observedAt: now,
      expiresAt,
      labels: geminiCliLabels
    }));
  }
  return meters;
}

export const geminiCliConnector: ConnectorContract = {
  id: "gemini_cli",
  displayName: "Gemini CLI",
  encoding: geminiCliEncoding,
  labels: geminiCliLabels,
  detect(environment) {
    return environment["GEMINI_CLI_USAGE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseGeminiCliPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
