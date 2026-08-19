// This interface is UNOFFICIAL and may break.
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
  shortExpiry,
  windowSeconds
} from "./shared.js";

/**
 * The Codex usage reader.
 *
 * The shape below is the one a working reader observed against a real account
 * on 2026-08-07, recorded in `Product Idea/reference-implementation`. OpenAI
 * publishes nothing about it, so it is DESIGN evidence and not verification
 * evidence: it tells us what to parse, and it does not turn an internal
 * endpoint into an official API. The labels below stay as they are, and the
 * provider stays UNVERIFIED, until a sanitized capture lands in the fixture
 * slot and even then the interface is still internal.
 *
 * The reader used to parse `rate_limits` with an s, a shape carried over from
 * an early prototype and never seen on the wire. The real field is
 * `rate_limit`, singular. That one letter is the whole reason the drift
 * machinery exists: both shapes are well formed JSON, both would have arrived
 * with a 200, and the wrong one produces no reading at all rather than a wrong
 * one only because this parser refuses whatever it was not told to expect.
 */

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

/** What this reader reads. JSON, because the endpoint answers JSON. */
export const codexEncoding = "json" as const;

/**
 * The observed response, reduced to what may be believed.
 *
 * `used_percent` is a percentage and `reset_at` is Unix epoch SECONDS. The
 * encoding was not guessed: the reference reader passes `reset_at` through
 * untouched into a cache whose consumers format it with an epoch formatter,
 * while it explicitly converts the other two providers' RFC3339 stamps first.
 *
 * `limit_window_seconds` is the window's own length, stated by the provider. It
 * is optional, because the reference treats it as optional, and its absence
 * costs only the plausibility bound: a window whose length is unknown cannot be
 * called rolling, so it is reported as an unknown window rather than as a five
 * hour one this build made up.
 *
 * Every window carried in the rate limit object is parsed into its own meter,
 * identified by its own `limit_window_seconds`. Plans may carry a weekly
 * primary window, a secondary window, or model-specific buckets, and ignoring
 * any window would present a partial picture of the user's quota.
 */
/**
 * The meter id for a window, from its length rather than its name.
 *
 * The two lengths that have names here are the two a reader elsewhere already
 * uses, so a five hour Codex window and a five hour Claude window are called the
 * same thing and the dashboard can group them. Anything else keeps its own key,
 * uppercased, which is enough to keep two windows apart without inventing a
 * vocabulary for buckets we have not seen yet.
 */
function meterIdFor(lengthSeconds: number | null, windowKey: string): string {
  if (lengthSeconds === 18_000) return "FIVE_HOUR";
  if (lengthSeconds === 604_800) return "SEVEN_DAY";
  return windowKey.replace(/_window$/, "").toUpperCase();
}

export function parseCodexPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const limits = record(root?.["rate_limit"]);
  if (limits === null) return null;
  const meters: RawMeter[] = [];
  for (const windowKey of Object.keys(limits)) {
    if (!windowKey.endsWith("_window")) continue;
    const windowRecord = record(limits[windowKey]);
    if (windowRecord === null) continue;
    const percent = boundedNumber(windowRecord["used_percent"]);
    if (percent === null) continue;
    const length = windowSeconds(windowRecord["limit_window_seconds"]);
    /*
     * A window may arrive with no reset_at at all. The reference reader emits
     * exactly that: it passes `pw.get("reset_at")` straight through, which is
     * null when the field is absent, and it still renders the percent. Dropping
     * such a window silently discards a real reading, which is a worse failure
     * than a missing countdown: the number the provider actually stated would
     * vanish. So an ABSENT reset_at keeps the window with an unknown reset time,
     * meaning resetAt stays null and the surface shows the percent with no
     * countdown.
     *
     * A reset_at that is PRESENT but unreadable is a different thing. A reset in
     * milliseconds, in the past, past its plausible horizon, or in the wrong
     * type is drift, not an absence, and it still drops the window. A corrupt
     * reset is not the same as no reset, and only the corrupt one is refused.
     */
    const resetProvided =
      windowRecord["reset_at"] !== undefined && windowRecord["reset_at"] !== null;
    const resetAt = resetProvided
      ? futureInstantFromEpochSeconds(
          windowRecord["reset_at"],
          now,
          length === null ? undefined : plausibleResetHorizon(length)
        )
      : null;
    const expiresAt = shortExpiry(now);
    if (expiresAt === null) continue;
    if (resetProvided && resetAt === null) continue;
    meters.push(
      rawMeter({
        provider: "CODEX",
        // Named by the window's OWN length, never by its position in the
        // payload. Codex can report the bucket it calls "primary" as a weekly
        // one, so naming from the key would put a seven day number under a
        // label that reads like a session. Two windows sharing one id was the
        // first version of this fix and it collided them into one meter.
        meter: meterIdFor(length, windowKey),
        value: percent,
        window:
          length === null
            ? { kind: "unknown" }
            : { kind: "rolling", durationSeconds: length },
        resetAt,
        source: "internal_payload",
        precision: "estimated",
        observedAt: now,
        expiresAt,
        labels: codexLabels
      })
    );
  }
  return meters.length === 0 ? null : meters;
}

export const codexConnector: ConnectorContract = {
  id: "codex",
  displayName: "Codex",
  encoding: "json",
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
