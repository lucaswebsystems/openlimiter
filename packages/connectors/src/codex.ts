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
  instantAfter,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry,
  windowSeconds
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

const legacyCodexLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

function meterIdForMinutes(minutes: number | null, slot: "primary" | "secondary"): string {
  if (minutes === null) return slot.toUpperCase();
  if (minutes === 300) return "FIVE_HOUR";
  if (minutes === 10_080) return "SEVEN_DAY";
  return slot.toUpperCase();
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

function suffixedMeter(meter: string, slot: string): string {
  const suffix = `_${slot.toUpperCase()}`;
  return `${meter.slice(0, 32 - suffix.length).replace(/_+$/u, "")}${suffix}`;
}

function decimal(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function windowsFrom(
  snapshot: Record<string, unknown>,
  limitId: string,
  now: string,
  expiresAt: string
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
      minutes <= 0 ||
      minutes > 525_600
    )) continue;
    const resetValue = window["resetsAt"];
    const resetAt = resetValue === undefined || resetValue === null
      ? null
      : futureInstantFromEpochSeconds(resetValue, now);
    if (resetValue !== undefined && resetValue !== null && resetAt === null) continue;
    const durationMeter = meterIdForMinutes(minutes, slot);
    parsed.push({
      slot,
      meter: rawMeter({
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
      })
    });
  }
  const counts = new Map<string, number>();
  for (const { meter } of parsed) {
    const meterId = meter.meter as string;
    counts.set(meterId, (counts.get(meterId) ?? 0) + 1);
  }
  return parsed.map(({ slot, meter }) => (counts.get(meter.meter as string) ?? 0) > 1
    ? { ...meter, meter: suffixedMeter(meter.meter as string, slot) }
    : meter);
}

function monthlyCreditLimit(
  value: unknown,
  now: string,
  expiresAt: string,
): RawMeter | null {
  const limit = record(value);
  if (limit === null) return null;
  const ceiling = typeof limit["limit"] === "string"
    ? decimal(limit["limit"])
    : boundedNumber(limit["limit"], 1_000_000_000_000);
  const used = typeof limit["used"] === "string"
    ? decimal(limit["used"])
    : boundedNumber(limit["used"], 1_000_000_000_000);
  const remaining = boundedNumber(limit["remainingPercent"]);
  const resetAt = futureInstantFromEpochSeconds(limit["resetsAt"], now);
  if (
    ceiling === null || ceiling <= 0 ||
    used === null || used > ceiling ||
    remaining === null || resetAt === null
  ) return null;
  return rawMeter({
    provider: "CODEX",
    meter: "MONTHLY_CREDIT_LIMIT",
    value: Math.round((100 - remaining) * 1_000_000_000_000) / 1_000_000_000_000,
    window: { kind: "fixed" },
    resetAt,
    source: "documented_api",
    precision: "exact",
    observedAt: now,
    expiresAt,
    labels: codexLabels,
  });
}

function resetFromCountdown(
  value: unknown,
  now: string,
  lengthSeconds: number | null
): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const horizon = lengthSeconds === null ? null : plausibleResetHorizon(lengthSeconds);
  if (horizon !== null && value > horizon) return null;
  return instantAfter(now, value);
}

function meterIdFor(lengthSeconds: number | null, windowKey: string): string {
  if (lengthSeconds === 18_000) return "FIVE_HOUR";
  if (lengthSeconds === 604_800) return "SEVEN_DAY";
  return windowKey.replace(/_window$/, "").toUpperCase();
}

function parseLegacyCodexPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const limits = record(root?.["rate_limit"]);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null) return null;
  const meters: RawMeter[] = [];
  for (const windowKey of Object.keys(limits ?? {})) {
    if (!windowKey.endsWith("_window")) continue;
    const windowRecord = record(limits?.[windowKey]);
    if (windowRecord === null) continue;
    const percent = boundedNumber(windowRecord["used_percent"]);
    if (percent === null) continue;
    const length = windowSeconds(windowRecord["limit_window_seconds"]);
    /*
     * A window may arrive with no reset_at at all. The reference reader emits
     * exactly that: it passes `pw.get("reset_at")` straight through, which is
     * null when the field is absent, and it still renders the percent. Dropping
     * such a window silently discards a real reading, which is a worse failure
     * than a missing countdown: the number the provider actually stated would
     * vanish. So an ABSENT reset_at keeps the window with an unknown reset time,
     * meaning resetAt stays null and the surface shows the percent with no
     * countdown.
     *
     * A reset_at that is PRESENT but unreadable is a different thing. A reset in
     * milliseconds, in the past, past its plausible horizon, or in the wrong
     * type is drift, not an absence, and it still drops the window. A corrupt
     * reset is not the same as no reset, and only the corrupt one is refused.
     */
    const resetProvided =
      windowRecord["reset_at"] !== undefined && windowRecord["reset_at"] !== null;
    const countdownProvided =
      windowRecord["reset_after_seconds"] !== undefined &&
      windowRecord["reset_after_seconds"] !== null;
    /* The instant form wins when both are present. It is absolute, so it
       survives a slow response and a clock this machine reads differently,
       while a countdown is only true at the moment it was written. */
    const resetAt = resetProvided
      ? futureInstantFromEpochSeconds(
          windowRecord["reset_at"],
          now,
          length === null ? undefined : plausibleResetHorizon(length)
        )
      : countdownProvided
        ? resetFromCountdown(windowRecord["reset_after_seconds"], now, length)
        : null;
    if ((resetProvided || countdownProvided) && resetAt === null) continue;
    meters.push(
      rawMeter({
        provider: "CODEX",
        // Named by the window's OWN length, never by its position in the
        // payload. Codex can report the bucket it calls "primary" as a weekly
        // one, so naming from the key would put a seven day number under a
        // label that reads like a session. Two windows sharing one id was the
        // first version of this fix and it collided them into one meter.
        meter: meterIdFor(length, windowKey),
        value: percent,
        window:
          length === null
            ? { kind: "unknown" }
            : { kind: "rolling", durationSeconds: length },
        resetAt,
        source: "internal_payload",
        precision: "estimated",
        observedAt: now,
        expiresAt,
        labels: legacyCodexLabels
      })
    );
  }
  if (record(root["credits"])?.["unlimited"] === true) {
    meters.push({
      provider: "CODEX",
      meter: "CREDITS",
      availability: "unlimited",
      // Required legacy transport fields; availability carries no percentage.
      value: 0,
      unit: "PERCENT",
      window: { kind: "unknown" },
      resetAt: null,
      source: "internal_payload",
      precision: "exact",
      observedAt: now,
      expiresAt,
      labels: legacyCodexLabels
    });
  }
  return meters.length === 0 ? null : meters;
}

export function parseCodexPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const defaultLimits = record(root?.["rateLimits"]);
  const expiresAt = shortExpiry(now);
  if (root === null || expiresAt === null) return null;
  if (defaultLimits === null) return parseLegacyCodexPayload(payload, now);
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
      const entryMeters = windowsFrom(snapshot, limitId, now, expiresAt);
      const monthly = monthlyCreditLimit(snapshot["individualLimit"], now, expiresAt);
      if (entryMeters.length > 0 && limitId === defaultLimitId) defaultCovered = true;
      meters.push(...entryMeters);
      if (monthly !== null) meters.push(monthly);
    }
  }
  if (!defaultCovered && defaultLimitId !== null) {
    const defaultMeters = windowsFrom(defaultLimits, defaultLimitId, now, expiresAt);
    const monthly = monthlyCreditLimit(defaultLimits["individualLimit"], now, expiresAt);
    if (monthly !== null) defaultMeters.push(monthly);
    meters.unshift(...defaultMeters);
  }
  const credits = record(defaultLimits["credits"]);
  if (credits?.["unlimited"] === true) {
    meters.push({
      provider: "CODEX",
      meter: "CREDITS",
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
      labels: codexLabels
    });
  } else if (credits?.["hasCredits"] === true) {
    const balance = decimal(credits["balance"]);
    if (balance !== null) {
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
        labels: codexLabels
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
