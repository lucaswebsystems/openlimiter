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

export const codexLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const codexInput = {
  kind: "provider_managed_payload",
  pathTemplate: "{providerState}/usage.json",
  readMode: "read_only"
} as const;

export function parseCodexPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const limits = record(root?.["rate_limits"]);
  const primary = record(limits?.["primary_window"]);
  const percent = boundedNumber(primary?.["used_percent"]);
  const resetAt = futureInstant(primary?.["reset_at"], now);
  const expiresAt = shortExpiry(now);
  if (percent === null || resetAt === null || expiresAt === null) return null;
  return [rawMeter({
    provider: "CODEX",
    meter: "PRIMARY",
    value: percent,
    window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt,
    source: "internal_payload",
    precision: "estimated",
    observedAt: now,
    expiresAt,
    labels: codexLabels
  })];
}

export const codexConnector: ConnectorContract = {
  id: "codex",
  displayName: "Codex",
  labels: codexLabels,
  detect(environment) {
    return environment["CODEX_USAGE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseCodexPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
