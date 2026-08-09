// This interface is UNOFFICIAL and may break.
import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import { boundedNumber, futureInstant, rawMeter, record, shortExpiry } from "./shared.js";

export const claudeLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "native-statusline-payload",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const claudeInput = {
  kind: "statusline_payload",
  path: null,
  readMode: "read_only"
} as const;

function parseWindow(
  value: unknown,
  now: string,
  meter: string,
  durationSeconds: number
): RawMeter | null {
  const input = record(value);
  if (input === null) return null;
  const percent = boundedNumber(input["utilization"]);
  const resetAt = futureInstant(input["resets_at"], now);
  const expiresAt = shortExpiry(now);
  if (percent === null || resetAt === null || expiresAt === null) return null;
  return rawMeter({
    provider: "CLAUDE",
    meter,
    value: percent,
    window: { kind: "rolling", durationSeconds },
    resetAt,
    source: "native_payload",
    precision: "exact",
    observedAt: now,
    expiresAt,
    labels: claudeLabels
  });
}

export function parseClaudePayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const limits = record(root?.["rate_limits"]);
  if (limits === null) return null;
  const meters: RawMeter[] = [];
  if ("five_hour" in limits) {
    const parsed = parseWindow(limits["five_hour"], now, "FIVE_HOUR", 18_000);
    if (parsed === null) return null;
    meters.push(parsed);
  }
  if ("seven_day" in limits) {
    const parsed = parseWindow(limits["seven_day"], now, "SEVEN_DAY", 604_800);
    if (parsed === null) return null;
    meters.push(parsed);
  }
  return meters.length === 0 ? null : meters;
}

export const claudeConnector: ConnectorContract = {
  id: "claude",
  displayName: "Claude",
  labels: claudeLabels,
  detect(environment) {
    return environment["CLAUDE_CODE_STATUSLINE"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseClaudePayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
