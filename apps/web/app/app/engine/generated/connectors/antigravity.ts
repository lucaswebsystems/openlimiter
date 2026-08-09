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
import { boundedNumber, futureInstant, rawMeter, record, shortExpiry } from "./shared";

export const antigravityLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const antigravityInput = {
  kind: "provider_managed_payload",
  pathTemplate: "{providerState}/quota.json",
  readMode: "read_only"
} as const;

export function parseAntigravityPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const quota = record(root?.["quota"]);
  const percent = boundedNumber(quota?.["used_percent"]);
  const resetAt = futureInstant(quota?.["reset_at"], now);
  const expiresAt = shortExpiry(now);
  if (percent === null || resetAt === null || expiresAt === null) return null;
  return [rawMeter({
    provider: "ANTIGRAVITY",
    meter: "PRIMARY",
    value: percent,
    window: { kind: "fixed" },
    resetAt,
    source: "internal_payload",
    precision: "estimated",
    observedAt: now,
    expiresAt,
    labels: antigravityLabels
  })];
}

export const antigravityConnector: ConnectorContract = {
  id: "antigravity",
  displayName: "Antigravity",
  labels: antigravityLabels,
  detect(environment) {
    return environment["ANTIGRAVITY_USAGE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseAntigravityPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
