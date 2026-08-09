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

/** File name the manual connector reads inside the state directory. */
export const MANUAL_FILE_NAME = "manual.json";

/**
 * Environment marker the CLI sets when that file is present.
 *
 * Detection stays pure: the connector only reads the supplied environment map,
 * and the caller is the one that looks at the disk.
 */
export const MANUAL_FILE_MARKER = "OPENLIMITER_MANUAL_FILE";

export const manualInput = {
  kind: "user_input",
  pathTemplate: "{openlimiterState}/" + MANUAL_FILE_NAME,
  readMode: "read_only"
} as const;

const safeName = /^[A-Z][A-Z0-9_]{0,31}$/u;
const MAX_ENTRIES = 10;

/**
 * Parse a manual quota document.
 *
 * Shape: { "version": 1, "meters": [ { "name": "MONTHLY",
 * "used_percent": 35, "reset_at": "2026-09-01T00:00:00.000Z" } ] }
 *
 * A row that fails validation is dropped, the remaining rows still count, and
 * a document where nothing survives returns null. Nothing is repaired.
 */
export function parseManualPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const entries = root?.["meters"];
  const expiresAt = shortExpiry(now);
  if (!Array.isArray(entries) || entries.length === 0 || expiresAt === null) return null;
  const meters: RawMeter[] = [];
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const input = record(entry);
    const name = input?.["name"];
    const percent = boundedNumber(input?.["used_percent"]);
    const resetAt = futureInstant(input?.["reset_at"], now);
    if (
      typeof name !== "string" ||
      !safeName.test(name) ||
      percent === null ||
      resetAt === null
    ) continue;
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
  return meters.length === 0 ? null : meters;
}

export const manualConnector: ConnectorContract = {
  id: "manual",
  displayName: "Manual",
  labels: manualLabels,
  detect(environment) {
    return environment[MANUAL_FILE_MARKER] === "available";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseManualPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
