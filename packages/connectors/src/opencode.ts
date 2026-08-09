// This interface is UNOFFICIAL and may break.
import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import { boundedNumber, futureInstant, rawMeter, record, shortExpiry } from "./shared.js";

export const opencodeLabels = {
  credentialOrigin: "browser-session",
  dataInterfaceStatus: "authenticated-scrape",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const opencodeHonesty = "UNVERIFIED_AUTHENTICATED_SCRAPE_HIGH_RISK" as const;

export const opencodeInput = {
  kind: "authenticated_page_payload",
  pathTemplate: "{browserSession}/usage",
  readMode: "read_only",
  honesty: opencodeHonesty
} as const;

export function parseOpencodePayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const usage = record(root?.["usage"]);
  const percent = boundedNumber(usage?.["percent"]);
  const resetAt = futureInstant(usage?.["reset_at"], now);
  const expiresAt = shortExpiry(now);
  if (percent === null || resetAt === null || expiresAt === null) return null;
  return [rawMeter({
    provider: "OPENCODE",
    meter: "PRIMARY",
    value: percent,
    window: { kind: "fixed" },
    resetAt,
    source: "authenticated_page",
    precision: "estimated",
    observedAt: now,
    expiresAt,
    labels: opencodeLabels
  })];
}

export const opencodeConnector: ConnectorContract = {
  id: "opencode",
  displayName: "OpenCode",
  labels: opencodeLabels,
  detect(environment) {
    return environment["OPENCODE_SESSION_PRESENT"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseOpencodePayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
