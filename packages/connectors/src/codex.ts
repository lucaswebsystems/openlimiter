import type {
  ConnectionTool,
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import {
  boundedNumber,
  connectorConnection,
  futureInstantFromEpochSeconds,
  rawMeter,
  record,
  shortExpiry
} from "./shared.js";

export const codexLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "documented-api",
  automationRisk: "low",
  verification: "VERIFIED_FIXTURES"
} as const satisfies ConnectorLabels;

export const codexInput = {
  kind: "local_command",
  command: "codex app-server",
  readMode: "read_only"
} as const;

/** What this reader reads. JSON, because the app server answers JSONL messages. */
export const codexEncoding = "json" as const;

/**
 * Protocol pinned 2026-10-01. The wire contract is the v2 app-server account
 * schema documented at https://learn.chatgpt.com/docs/app-server and generated
 * from https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol.
 */
function meterIdForMinutes(minutes: number | null, slot: "primary" | "secondary"): string {
  if (minutes === null) return slot.toUpperCase();
  if (minutes === 300) return "FIVE_HOUR";
  if (minutes === 10_080) return "SEVEN_DAY";
  return `WINDOW_${minutes}_MINUTE`;
}

function readableLimitId(value: string): string | null {
  const readable = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toUpperCase();
  return readable.length > 0 ? readable : null;
}

function prefixedMeter(limitId: string, duration: string): string {
  if (limitId === "CODEX") return duration;
  const prefixLength = Math.max(1, 31 - duration.length);
  return `${limitId.slice(0, prefixLength).replace(/_+$/u, "")}_${duration}`;
}

function accountId(root: Record<string, unknown>): string | undefined {
  const stated = root["accountId"];
  return typeof stated === "string" && /^codex-[0-9a-f]{24}$/u.test(stated)
    ? stated
    : undefined;
}

function windowsFrom(
  snapshot: Record<string, unknown>,
  limitId: string,
  now: string,
  expiresAt: string,
  statedAccountId: string | undefined
): RawMeter[] {
  const windows = ["primary", "secondary"] as const;
  const parsed: Array<{ slot: string; meter: RawMeter }> = [];
  for (const slot of windows) {
    const window = record(snapshot[slot]);
    if (window === null) continue;
    const percent = boundedNumber(window["usedPercent"]);
    const minutes = window["windowDurationMins"];
    if (percent === null) continue;
    if (minutes !== null && (
      typeof minutes !== "number" ||
      !Number.isSafeInteger(minutes) ||
      minutes <= 0
    )) continue;
    const resetValue = window["resetsAt"];
    const resetAt = resetValue === undefined || resetValue === null
      ? null
      : futureInstantFromEpochSeconds(resetValue, now);
    if (resetValue !== undefined && resetValue !== null && resetAt === null) continue;
    const durationMeter = meterIdForMinutes(minutes, slot);
    parsed.push({
      slot,
      meter: {
        ...rawMeter({
          provider: "CODEX",
          meter: prefixedMeter(limitId, durationMeter),
          value: percent,
          window: minutes === null
            ? { kind: "unknown" }
            : { kind: "rolling", durationSeconds: minutes * 60 },
          resetAt,
          source: "documented_api",
          precision: "exact",
          observedAt: now,
          expiresAt,
          labels: codexLabels
        }),
        ...(statedAccountId === undefined ? {} : { accountId: statedAccountId })
      }
    });
  }

  const duplicateIds = new Set<string>();
  for (const { meter } of parsed) {
    if (parsed.filter((entry) => entry.meter.meter === meter.meter).length > 1) {
      duplicateIds.add(String(meter.meter));
    }
  }
  return parsed.map(({ slot, meter }) => duplicateIds.has(String(meter.meter))
    ? { ...meter, meter: `${String(meter.meter)}_${slot.toUpperCase()}` }
    : meter);
}

export function parseCodexPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const defaultLimits = record(root?.["rateLimits"]);
  const expiresAt = shortExpiry(now);
  if (root === null || defaultLimits === null || expiresAt === null) return null;
  const statedAccountId = accountId(root);
  const meters: RawMeter[] = [];
  const statedDefaultId = typeof defaultLimits["limitId"] === "string"
    ? defaultLimits["limitId"]
    : "codex";
  const defaultLimitId = readableLimitId(statedDefaultId);
  let defaultCovered = false;
  const byLimitId = record(root["rateLimitsByLimitId"]);
  if (byLimitId !== null) {
    for (const [mapId, value] of Object.entries(byLimitId)) {
      const snapshot = record(value);
      if (snapshot === null) continue;
      const statedId = typeof snapshot["limitId"] === "string"
        ? snapshot["limitId"]
        : mapId;
      const limitId = readableLimitId(statedId);
      if (limitId === null) continue;
      const entryMeters = windowsFrom(snapshot, limitId, now, expiresAt, statedAccountId);
      if (entryMeters.length > 0 && limitId === defaultLimitId) defaultCovered = true;
      meters.push(...entryMeters);
    }
  }
  if (!defaultCovered && defaultLimitId !== null) {
    meters.unshift(...windowsFrom(defaultLimits, defaultLimitId, now, expiresAt, statedAccountId));
  }

  const credits = record(defaultLimits["credits"]);
  if (credits?.["unlimited"] === true) {
    meters.push({
      provider: "CODEX",
      meter: "CREDITS",
      kind: "availability",
      availability: "unlimited",
      // Required legacy transport fields; availability carries no percentage.
      value: 0,
      unit: "PERCENT",
      window: { kind: "unknown" },
      resetAt: null,
      source: "documented_api",
      precision: "exact",
      observedAt: now,
      expiresAt,
      labels: codexLabels,
      ...(statedAccountId === undefined ? {} : { accountId: statedAccountId })
    });
  } else if (credits?.["hasCredits"] === true) {
    const balance = typeof credits["balance"] === "string"
      ? Number(credits["balance"])
      : Number.NaN;
    if (Number.isFinite(balance) && balance >= 0) {
      meters.push({
        provider: "CODEX",
        meter: "CREDITS",
        value: balance,
        unit: "CREDITS",
        window: { kind: "lifetime" },
        resetAt: null,
        source: "documented_api",
        precision: "exact",
        observedAt: now,
        expiresAt,
        labels: codexLabels,
        ...(statedAccountId === undefined ? {} : { accountId: statedAccountId })
      });
    }
  }
  return meters.length === 0 ? null : meters;
}

/** The local application that owns this credential. */
export const CODEX_TOOL: ConnectionTool = "Codex CLI";

export const codexConnector: ConnectorContract = {
  id: "codex",
  displayName: "Codex",
  encoding: "json",
  labels: codexLabels,
  detect(environment) {
    return environment["CODEX_USAGE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseCodexPayload(context.payload, context.now);
    const connection = connectorConnection(
      meters !== null,
      context.payload,
      CODEX_TOOL
    );
    return meters === null
      ? { ok: false, reason: "unknown", connection }
      : { ok: true, meters, connection };
  }
};
