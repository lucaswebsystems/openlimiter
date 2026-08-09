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

const windows = [
  { key: "five_hour", meter: "FIVE_HOUR", durationSeconds: 18_000 },
  { key: "seven_day", meter: "SEVEN_DAY", durationSeconds: 604_800 }
] as const;

/**
 * Parse the rate limit block of a Claude Code statusline payload.
 *
 * Shape: { "rate_limits": { "five_hour": { "utilization": 42,
 * "resets_at": "2026-09-01T05:00:00.000Z" }, "seven_day": { ... } } }
 *
 * A window that fails validation is dropped and the other window still counts,
 * because one expired window is not a reason to forget the whole session.
 */
export function parseClaudePayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const limits = record(root?.["rate_limits"]);
  if (limits === null) return null;
  const meters: RawMeter[] = [];
  for (const window of windows) {
    if (!(window.key in limits)) continue;
    const parsed = parseWindow(
      limits[window.key],
      now,
      window.meter,
      window.durationSeconds
    );
    if (parsed !== null) meters.push(parsed);
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
