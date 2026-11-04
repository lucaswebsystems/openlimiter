// This interface is UNOFFICIAL and may break.
import type {
  ConnectionTool,
  ConnectorContract,
  ConnectorLabels,
  ConnectorMaturity,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import {
  connectorConnection,
  futureInstantFromRfc3339,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry
} from "./shared.js";

/**
 * The OpenCode Go usage reader. Its token is the sign in the opencode CLI saved
 * on this computer, or an OpenCode API key, and it reads the JSON reply of one
 * request to an endpoint OpenCode does not document.
 *
 * Rolling and weekly windows are required, monthly is optional, and any window
 * with an unknown status or an impossible percentage rejects the whole reply:
 * an undocumented shape that changed is not read approximately.
 */

export const opencodeLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

/** BETA: the endpoint is undocumented and nobody promised its shape. */
export const opencodeMaturity = "beta" as const satisfies ConnectorMaturity;

export const opencodeEncoding = "json" as const;

/** Each window the reply states, its meter, its length and whether it must be there. */
const WINDOWS = [
  { field: "rolling", meter: "FIVE_HOUR", seconds: 18_000, required: true },
  { field: "weekly", meter: "SEVEN_DAY", seconds: 604_800, required: true },
  { field: "monthly", meter: "MONTHLY", seconds: 2_592_000, required: false }
] as const;

export function parseOpencodePayload(payload: unknown, now: string): RawMeter[] | null {
  const usage = record(record(payload)?.["usage"]);
  const expiresAt = shortExpiry(now);
  if (usage === null || expiresAt === null) return null;
  const meters: RawMeter[] = [];
  for (const { field, meter, seconds, required } of WINDOWS) {
    if (!(field in usage)) {
      if (required) return null;
      continue;
    }
    const window = record(usage[field]);
    if (window === null) return null;
    const status = window["status"];
    if (status !== "ok" && status !== "rate-limited") return null;
    const percent = window["percent"];
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      return null;
    }
    meters.push(rawMeter({
      provider: "OPENCODE",
      meter,
      value: status === "rate-limited" ? 100 : percent,
      window: { kind: "rolling", durationSeconds: seconds },
      resetAt: futureInstantFromRfc3339(window["resetsAt"], now, plausibleResetHorizon(seconds)),
      source: "internal_payload",
      precision: "estimated",
      observedAt: now,
      expiresAt,
      labels: opencodeLabels
    }));
  }
  return meters;
}

/** The local application that owns this credential. */
export const OPENCODE_TOOL: ConnectionTool = "OpenCode";

export const opencodeConnector: ConnectorContract = {
  id: "opencode",
  displayName: "OpenCode",
  encoding: opencodeEncoding,
  maturity: opencodeMaturity,
  labels: opencodeLabels,
  detect(environment) {
    return environment["OPENCODE_USAGE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseOpencodePayload(context.payload, context.now);
    const connection = connectorConnection(meters !== null, context.payload, OPENCODE_TOOL);
    return meters === null
      ? { ok: false, reason: "unknown", connection }
      : { ok: true, meters, connection };
  }
};
