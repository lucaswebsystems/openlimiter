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
import { antigravityMeter } from "../core";
import { connectorConnection, rawMeter, record, shortExpiry } from "./shared";

/** Antigravity documents this payload as the standard input to its status line. */
export const antigravityLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "native-statusline-payload",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const antigravityInput = {
  kind: "native_statusline_payload",
  pathTemplate: "standard input",
  readMode: "read_only"
} as const;

export const antigravityEncoding = "json" as const;

function remainingFraction(bucket: Record<string, unknown>): number | null {
  const value = typeof bucket["remaining_fraction"] === "number"
    ? bucket["remaining_fraction"]
    : typeof bucket["remainingFraction"] === "number"
      ? bucket["remainingFraction"]
      : null;
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function resetInstant(bucket: Record<string, unknown>): string | null {
  const value = typeof bucket["reset_time"] === "string"
    ? bucket["reset_time"]
    : typeof bucket["resetTime"] === "string"
      ? bucket["resetTime"]
      : null;
  if (value === null || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Parse only the documented quota map. Unknown bucket identities are omitted. */
export function parseAntigravityPayload(payload: unknown, observedAt: string): RawMeter[] | null {
  const root = record(payload);
  const quota = record(root?.["quota"]);
  const expiresAt = shortExpiry(observedAt);
  if (quota === null || expiresAt === null) return null;

  const meters: RawMeter[] = [];
  for (const [bucketId, value] of Object.entries(quota)) {
    const bucket = record(value);
    const remaining = bucket === null ? null : remainingFraction(bucket);
    const mapped = antigravityMeter(bucketId.toLowerCase());
    if (bucket === null || remaining === null || mapped === null) continue;
    meters.push(rawMeter({
      provider: "ANTIGRAVITY",
      meter: mapped.meter,
      value: Math.round((1 - remaining) * 1_000) / 10,
      window: { kind: "rolling", durationSeconds: mapped.durationSeconds },
      resetAt: resetInstant(bucket),
      source: "native_payload",
      precision: "estimated",
      observedAt,
      expiresAt,
      labels: antigravityLabels
    }));
  }
  return meters.length === 0 ? null : meters;
}

export const ANTIGRAVITY_TOOL: ConnectionTool = "Antigravity";

export const antigravityConnector: ConnectorContract = {
  id: "antigravity",
  displayName: "Antigravity",
  encoding: antigravityEncoding,
  labels: antigravityLabels,
  detect(environment) {
    return environment["ANTIGRAVITY_STATUSLINE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseAntigravityPayload(context.payload, context.now);
    const connection = connectorConnection(meters !== null, context.payload, ANTIGRAVITY_TOOL);
    return meters === null
      ? { ok: false, reason: "unknown", connection }
      : { ok: true, meters, connection };
  }
};
