import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import { boundedNumber, futureInstant, rawMeter, record, shortExpiry } from "./shared.js";

export const manualLabels = {
  credentialOrigin: "user-entered",
  dataInterfaceStatus: "manual",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const manualInput = {
  kind: "user_input",
  pathTemplate: "{openlimiterState}/manual.json",
  readMode: "read_only"
} as const;

const safeName = /^[A-Z][A-Z0-9_]{0,31}$/u;

export function parseManualPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const entries = root?.["meters"];
  const expiresAt = shortExpiry(now);
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 10 || expiresAt === null) {
    return null;
  }
  const meters: RawMeter[] = [];
  for (const entry of entries) {
    const input = record(entry);
    const name = input?.["name"];
    const percent = boundedNumber(input?.["used_percent"]);
    const resetAt = futureInstant(input?.["reset_at"], now);
    if (
      typeof name !== "string" ||
      !safeName.test(name) ||
      percent === null ||
      resetAt === null
    ) return null;
    meters.push(rawMeter({
      provider: "MANUAL",
      meter: name,
      value: percent,
      window: { kind: "fixed" },
      resetAt,
      source: "manual_entry",
      precision: "manual",
      observedAt: now,
      expiresAt,
      labels: manualLabels
    }));
  }
  return meters;
}

export const manualConnector: ConnectorContract = {
  id: "manual",
  displayName: "Manual",
  labels: manualLabels,
  detect() {
    return true;
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseManualPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
