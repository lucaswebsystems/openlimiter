import type { ConnectorResult, ProviderCode } from "./types.js";

/**
 * Why a provider has nothing to show, in our own words.
 *
 * SECURITY. Not one character of a provider's own text ever reaches a human
 * surface. A connector can hand back a payload full of anything at all, and the
 * only thing that survives contact with this module is one of the four codes
 * below, chosen by our code from what the connector and the normalizer can
 * actually tell apart today. The sentences are constants written here, so a
 * failure line on a card, in a window, or in a terminal is the same fixed
 * string whatever the provider said.
 *
 * The four categories are exactly the four distinguishable outcomes:
 *
 *   NOT_CONFIGURED       the connector reported it has nothing set up
 *   SESSION_EXPIRED      the connector reported its credential no longer works
 *   PAYLOAD_UNREADABLE   the connector could not recognise what it was given
 *   VALIDATION_REJECTED  the connector recognised it, the normalizer refused it
 *   PROVIDER_DRIFT       a live response changed and withdrew earlier rows
 *
 * Nothing finer is claimed, because nothing finer can be told apart without
 * reading provider text, which is the one thing this module exists to prevent.
 */
export const FAILURE_CATEGORIES = [
  "NOT_CONFIGURED",
  "SESSION_EXPIRED",
  "PAYLOAD_UNREADABLE",
  "VALIDATION_REJECTED",
  "PROVIDER_DRIFT"
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * The one sentence each category is ever shown as.
 *
 * Short enough to sit on one line of a card, plain enough to need no glossary,
 * and fixed, so no surface can invent a variation of its own.
 */
export const failureSentence: Record<FailureCategory, string> = {
  NOT_CONFIGURED: "Not set up yet, so nothing was read.",
  SESSION_EXPIRED: "Session expired.",
  PAYLOAD_UNREADABLE: "Payload could not be read, so nothing is claimed.",
  VALIDATION_REJECTED: "Payload failed validation, kept the last good reading.",
  PROVIDER_DRIFT: "Provider response changed, so usage is unknown."
};

/** A provider and the one reason it has nothing readable. */
export interface ProviderFailure {
  provider: ProviderCode;
  category: FailureCategory;
}

/**
 * Map a connector's own refusal onto the shared vocabulary.
 *
 * The connector contract already narrows every refusal to three enum values, so
 * this is a total function over a closed set and can never see a surprise.
 */
export function failureFromConnectorReason(
  reason: Extract<ConnectorResult, { ok: false }>["reason"]
): FailureCategory {
  if (reason === "not_configured") return "NOT_CONFIGURED";
  if (reason === "unavailable") return "SESSION_EXPIRED";
  return "PAYLOAD_UNREADABLE";
}

/**
 * Collapse a list of failures to one per provider, worst first.
 *
 * A provider can only ever show one line, so when two sources disagree the more
 * specific answer wins: a reading that was rejected says more than a connector
 * that never produced one.
 */
const severity: Record<FailureCategory, number> = {
  NOT_CONFIGURED: 0,
  PAYLOAD_UNREADABLE: 1,
  SESSION_EXPIRED: 2,
  VALIDATION_REJECTED: 3,
  PROVIDER_DRIFT: 4
};

export function dedupeFailures(
  failures: readonly ProviderFailure[]
): readonly ProviderFailure[] {
  const byProvider = new Map<ProviderCode, ProviderFailure>();
  for (const failure of failures) {
    const held = byProvider.get(failure.provider);
    if (held === undefined || severity[failure.category] > severity[held.category]) {
      byProvider.set(failure.provider, failure);
    }
  }
  return [...byProvider.values()];
}
