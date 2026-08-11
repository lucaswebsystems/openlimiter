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
  boundedFraction,
  futureInstantFromRfc3339,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry
} from "./shared";

/**
 * The Antigravity quota reader.
 *
 * The shape below is the one a working reader observed against a real Google AI
 * Pro account on 2026-08-07, recorded in
 * `Product Idea/reference-implementation`. Design evidence, not verification
 * evidence: Google publishes nothing about this surface, so the provider stays
 * UNVERIFIED whatever we observe.
 *
 * The response is not a percentage in a field. It is a list of GROUPS, each
 * holding a list of BUCKETS, each bucket carrying `remainingFraction` between
 * zero and one, a window name, and an RFC3339 reset. Usage is one minus that
 * fraction. The reader used to parse `quota.used_percent`, a shape from an
 * early prototype that has never been seen on the wire.
 */

export const antigravityLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const antigravityInput = {
  kind: "provider_managed_payload",
  pathTemplate: "{providerState}/quota.json",
  readMode: "read_only"
} as const;

/** What this reader reads. JSON, because the endpoint answers JSON. */
export const antigravityEncoding = "json" as const;

/**
 * The bucket prefix naming the pool this provider tracks.
 *
 * Matched against the prefix of `bucketId` EXACTLY, never as a substring. A
 * hypothetical `3p-gemini-fallback` bucket would satisfy a naive containment
 * test and let a third party pool overwrite the real one, which is a wrong
 * number rather than a missing one.
 */
export const ANTIGRAVITY_TRACKED_POOL = "gemini";

/**
 * The window names this build understands, and how long each one is.
 *
 * Google spells them "5h" and "weekly". A window name outside this table is not
 * dropped: the whole payload is refused. Dropping it would remove a window that
 * might be the binding one and leave the meter confidently reporting a LOWER
 * number than the truth, which is the exact failure this product exists to
 * prevent.
 */
export const ANTIGRAVITY_WINDOWS: Readonly<Record<string, number>> = {
  "5h": 18_000,
  weekly: 604_800
};

interface ParsedWindow {
  percent: number;
  seconds: number;
  resetAt: string;
}

/**
 * Every bucket of one group, or null if any one of them cannot be believed.
 *
 * Whole rather than per bucket, for the reason above: a partially read group is
 * a group whose worst window may be the one that failed to read.
 */
function readBuckets(buckets: readonly unknown[], now: string): ParsedWindow[] | null {
  const windows: ParsedWindow[] = [];
  for (const entry of buckets) {
    const bucket = record(entry);
    if (bucket === null) return null;
    const fraction = boundedFraction(bucket["remainingFraction"]);
    if (fraction === null) return null;
    const name = bucket["window"];
    if (typeof name !== "string") return null;
    const seconds = ANTIGRAVITY_WINDOWS[name.toLowerCase()];
    if (seconds === undefined) return null;
    const resetAt = futureInstantFromRfc3339(
      bucket["resetTime"],
      now,
      plausibleResetHorizon(seconds)
    );
    if (resetAt === null) return null;
    /* One decimal, which is the precision the reference reader keeps and more
       than a quota bar can show. Clamped, because floating point subtraction
       of a fraction can land a hair outside the range. */
    const percent = Math.round(Math.max(0, Math.min(100, (1 - fraction) * 100)) * 10) / 10;
    windows.push({ percent, seconds, resetAt });
  }
  return windows.length === 0 ? null : windows;
}

/** The prefix of every bucket id in a group, or null if any is unreadable. */
function poolPrefixes(buckets: readonly unknown[]): Set<string> | null {
  const prefixes = new Set<string>();
  for (const entry of buckets) {
    const bucket = record(entry);
    if (bucket === null) return null;
    const id = bucket["bucketId"];
    if (typeof id !== "string") return null;
    const separator = id.indexOf("-");
    if (separator <= 0) return null;
    prefixes.add(id.slice(0, separator));
  }
  return prefixes;
}

/**
 * The tracked pool's binding window, as one meter.
 *
 * One meter rather than one per window, matching what the reference reader's
 * bar shows and what the registry declares: the BINDING window, meaning the one
 * with the highest usage, because that is the one that will stop the work.
 *
 * The third party pool that rides the same subscription is deliberately not
 * modelled. It is a real second wallet, and reporting it under this provider's
 * single meter would conflate two pools into one number. It needs its own
 * identity in the registry before it can have one here.
 */
export function parseAntigravityPayload(
  payload: unknown,
  now: string
): RawMeter[] | null {
  const root = record(payload);
  const groups = root?.["groups"];
  if (!Array.isArray(groups)) return null;
  let tracked: ParsedWindow[] | null = null;
  for (const entry of groups) {
    const group = record(entry);
    if (group === null) return null;
    const buckets = group["buckets"];
    if (!Array.isArray(buckets)) return null;
    const prefixes = poolPrefixes(buckets);
    if (prefixes === null) return null;
    if (!prefixes.has(ANTIGRAVITY_TRACKED_POOL)) continue;
    /* Two groups claiming the same pool is ambiguous, and picking one would be
       picking at random. */
    if (tracked !== null) return null;
    tracked = readBuckets(buckets, now);
    if (tracked === null) return null;
  }
  if (tracked === null) return null;
  const expiresAt = shortExpiry(now);
  if (expiresAt === null) return null;
  let binding = tracked[0]!;
  for (const candidate of tracked.slice(1)) {
    if (candidate.percent > binding.percent) binding = candidate;
  }
  return [rawMeter({
    provider: "ANTIGRAVITY",
    meter: "PRIMARY",
    value: binding.percent,
    window: { kind: "rolling", durationSeconds: binding.seconds },
    resetAt: binding.resetAt,
    source: "internal_payload",
    precision: "estimated",
    observedAt: now,
    expiresAt,
    labels: antigravityLabels
  })];
}

export const antigravityConnector: ConnectorContract = {
  id: "antigravity",
  displayName: "Antigravity",
  encoding: "json",
  labels: antigravityLabels,
  detect(environment) {
    return environment["ANTIGRAVITY_USAGE_PAYLOAD"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseAntigravityPayload(context.payload, context.now);
    return meters === null
      ? { ok: false, reason: "unknown" }
      : { ok: true, meters };
  }
};
