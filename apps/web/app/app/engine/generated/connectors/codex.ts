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
import {
  boundedNumber,
  futureInstantFromEpochSeconds,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry,
  windowSeconds
} from "./shared";

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
 * The secondary window is deliberately NOT modelled. Plans differ in whether
 * they have one, the registry declares a single meter, and folding a second
 * window into the same meter would silently report whichever one this build
 * happened to read last.
 */
export function parseCodexPayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  const limits = record(root?.["rate_limit"]);
  const primary = record(limits?.["primary_window"]);
  const percent = boundedNumber(primary?.["used_percent"]);
  if (percent === null) return null;
  const length = windowSeconds(primary?.["limit_window_seconds"]);
  const resetAt = futureInstantFromEpochSeconds(
    primary?.["reset_at"],
    now,
    length === null ? undefined : plausibleResetHorizon(length)
  );
  const expiresAt = shortExpiry(now);
  if (resetAt === null || expiresAt === null) return null;
  return [rawMeter({
    provider: "CODEX",
    meter: "PRIMARY",
    value: percent,
    window: length === null
      ? { kind: "unknown" }
      : { kind: "rolling", durationSeconds: length },
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
