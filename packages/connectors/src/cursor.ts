// Independently implemented from endpoint facts in research/01-codenotch-harvest.md.
// This internal interface is experimental; no live acquisition has been verified.
import type { ConnectorContract, ConnectorLabels, RawMeter } from "@openlimiter/core";
import { connectorConnection, record } from "./shared.js";

export const CURSOR_EXPERIMENTAL_LABEL =
  "Experimental: parser tested on fixtures; live acquisition unverified";
export const cursorLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "VERIFIED_FIXTURES"
} as const satisfies ConnectorLabels;

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12
    ? value : null;
}

function instant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export function parseCursorPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  if (root === null || root["error"] !== undefined) return null;
  const current = instant(now);
  const start = instant(root["billingCycleStart"]);
  const end = instant(root["billingCycleEnd"]);
  if (current === null || start === null || end === null || start > current || end <= current ||
      end <= start || end - start > 366 * 86_400_000) return null;
  const individual = record(root["individualUsage"]);
  if (individual === null) return null;
  const plan = record(individual["plan"]);
  const overall = record(individual["overall"]);
  if ((individual["plan"] !== undefined && plan === null) ||
      (individual["overall"] !== undefined && overall === null)) return null;
  const rows: RawMeter[] = [];
  const add = (meter: string, percent: number): void => {
    rows.push({
      // The frozen snapshot contract bounds a quota bar to 100.
      provider: "CURSOR", meter, value: Math.min(percent, 100), unit: "PERCENT",
      window: { kind: "fixed", durationSeconds: (end - start) / 1_000 },
      resetAt: new Date(end).toISOString(), source: "internal_payload", precision: meter === "INCLUDED" ? "estimated" : "exact",
      observedAt: now, expiresAt: new Date(current + 600_000).toISOString(),
      labels: cursorLabels, kind: "quota_percent"
    });
  };
  if (plan !== null) {
    for (const [field, meter] of [["autoPercentUsed", "AUTO"], ["apiPercentUsed", "API"]] as const) {
      if (plan[field] === undefined) continue;
      const value = numeric(plan[field]);
      if (value === null) return null;
      add(meter, value);
    }
  }
  if (overall !== null && overall["isUnlimited"] !== true) {
    const used = numeric(overall["used"]);
    const limit = numeric(overall["limit"]);
    if (used === null || limit === null || limit <= 0) return null;
    const percent = used / limit * 100;
    if (!Number.isFinite(percent) || percent > 1e12) return null;
    add("INCLUDED", percent);
  }
  // Unlimited is explicit, never converted into a zero usage quota.
  if (root["isUnlimited"] === true || individual["isUnlimited"] === true || overall?.["isUnlimited"] === true) {
    if (rows.length !== 0) return null;
    add("AUTO", 0);
    rows[0]!.availability = "unlimited";
  }
  return rows.length > 0 ? rows : null;
}

export const cursorConnector: ConnectorContract = {
  id: "cursor", displayName: "Cursor", encoding: "json", maturity: "experimental",
  labels: cursorLabels,
  detect: environment => environment["CURSOR_USAGE_PAYLOAD"] === "1",
  async read(context) {
    const meters = parseCursorPayload(context.payload, context.now);
    const connection = connectorConnection(meters !== null, context.payload, "Cursor");
    return meters === null ? { ok: false, reason: "unknown", connection } : { ok: true, meters, connection };
  }
};
