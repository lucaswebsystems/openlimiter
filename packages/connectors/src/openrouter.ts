import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import { boundedNumber, rawMeter, record, shortExpiry } from "./shared.js";

export const openrouterLabels = {
  credentialOrigin: "user-key",
  dataInterfaceStatus: "documented-api",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const openrouterCredential = {
  store: "operating_system",
  service: "openlimiter",
  account: "openrouter",
  repositoryPath: null,
  readMode: "read_only"
} as const;

export function parseOpenrouterPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const data = record(root?.["data"]);
  const credits = boundedNumber(data?.["total_credits"], 1_000_000_000_000);
  const usage = boundedNumber(data?.["total_usage"], 1_000_000_000_000);
  const expiresAt = shortExpiry(now);
  if (
    credits === null ||
    usage === null ||
    credits <= 0 ||
    usage > credits ||
    expiresAt === null
  ) return null;
  const percent = (usage / credits) * 100;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return [rawMeter({
    provider: "OPENROUTER",
    meter: "CREDITS",
    value: percent,
    window: { kind: "lifetime" },
    resetAt: null,
    source: "documented_api",
    precision: "exact",
    observedAt: now,
    expiresAt,
    labels: openrouterLabels
  })];
}

export const openrouterConnector: ConnectorContract = {
  id: "openrouter",
  displayName: "OpenRouter",
  labels: openrouterLabels,
  detect(environment) {
    return environment["OPENLIMITER_OPENROUTER_CREDENTIAL"] === "available";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseOpenrouterPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
