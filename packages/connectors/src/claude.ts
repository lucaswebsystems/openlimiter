/*
 * The one connector reading an interface the provider documents itself.
 *
 * Everything below is written against the published Claude Code statusline
 * contract, cited in full above parseClaudePayload.
 */
import type {
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter
} from "@openlimiter/core";
import {
  boundedNumber,
  futureInstantFromEpochSeconds,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry
} from "./shared.js";

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
  const percent = boundedNumber(input["used_percentage"]);
  /*
   * The reset has to belong to the window that named it. A five hour window
   * resetting years from now is a corrupt field, not a long wait, and it is
   * dropped on its own so the other window still reports.
   */
  const resetAt = futureInstantFromEpochSeconds(
    input["resets_at"],
    now,
    plausibleResetHorizon(durationSeconds)
  );
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
 * Documented shape, from https://code.claude.com/docs/en/statusline
 * reviewed 2026-08-10:
 *
 * ```json
 * {
 *   "rate_limits": {
 *     "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
 *     "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
 *   }
 * }
 * ```
 *
 * `used_percentage` is the share of the window consumed, from 0 to 100.
 * `resets_at` is Unix epoch SECONDS, a number, not a date string.
 *
 * Three absences the documentation states, and none of them is an error:
 *
 * 1. `rate_limits` appears only for Claude.ai subscribers on Pro or Max, and
 *    only after the first API response in the session. A payload without it is
 *    an ordinary payload from a free account or a session that has not called
 *    the API yet.
 * 2. Each window may be independently absent, so one present window is one
 *    meter and is a complete answer.
 * 3. No window present is the honest unknown, not zero.
 *
 * An earlier version of this parser read a field named `utilization` and an ISO
 * date string. No Claude Code release is known to have emitted either, and the
 * only thing that ever agreed with them was our own fixture, so nothing here
 * falls back to that shape.
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
