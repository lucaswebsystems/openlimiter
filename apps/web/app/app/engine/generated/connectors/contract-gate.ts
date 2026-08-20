/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * The runtime contract gate.
 *
 * Every parser in this package already answers null when a provider response
 * does not match the shape it was told to read. Null is the right answer, but
 * on its own it is easy to drop on the floor: a caller that maps a provider to
 * null and then filters nulls away makes the provider VANISH from the interface,
 * which reads as "this provider was never configured" rather than the truth,
 * "this provider answered and we could not believe the answer".
 *
 * This gate closes that gap. It takes a provider and a raw response and always
 * returns an EXPLICIT tagged outcome, never null and never a bare list:
 *
 *   { status: "ok", provider, meters }        the shape matched and at least
 *                                              one reading is believable
 *   { status: "unknown", provider, reason }   the response did not match, so
 *                                              the provider is VISIBLY unknown
 *
 * The unknown branch carries the provider it belongs to and a reason, so a
 * caller and the UI can render a provider whose number is unknown rather than
 * hide the provider or, worse, show a number the parser never produced. There
 * is no third outcome: a shape the gate cannot read is unknown, never a guess.
 *
 * The gate reuses the parsers and the core normalizer unchanged. It decides
 * nothing about the shape of a reading itself; it only turns a refusal into a
 * value a caller cannot accidentally discard.
 */
import {
  type ProviderCode,
  type RawMeter,
  normalizeMeters
} from "../core";
import { parseAntigravityPayload } from "./antigravity";
import { parseClaudePayload } from "./claude";
import { parseCodexPayload } from "./codex";
import { parseGrokPayload } from "./grok";
import { parseKimiPayload } from "./kimi";
import { parseManualPayload } from "./manual";
import { parseOpencodePayload } from "./opencode";
import { parseOpenrouterPayload } from "./openrouter";

/** Why a provider is unknown, in a closed vocabulary a surface can switch on. */
export type ContractUnknownReason =
  | "no_payload"
  | "unknown_provider"
  | "shape_mismatch"
  | "no_believable_meter";

export type ContractOutcome =
  | { status: "ok"; provider: ProviderCode; meters: readonly RawMeter[] }
  | { status: "unknown"; provider: ProviderCode; reason: ContractUnknownReason };

type Parser = (payload: unknown, now: string) => RawMeter[] | null;

/**
 * The one parser each provider's response is allowed to reach.
 *
 * Closed to known provider codes. A provider with no generic payload parser
 * here is not defaulted to a neighbour's; it is unknown, for the same reason
 * the parsers themselves carry no fallback. Native collectors may write
 * already normalized snapshots without exposing their private payload to this
 * generic boundary.
 */
const PARSER_BY_PROVIDER: Readonly<Partial<Record<ProviderCode, Parser>>> = {
  CLAUDE: parseClaudePayload,
  OPENROUTER: parseOpenrouterPayload,
  CODEX: parseCodexPayload,
  ANTIGRAVITY: parseAntigravityPayload,
  OPENCODE: parseOpencodePayload,
  GROK: parseGrokPayload,
  KIMI: parseKimiPayload,
  MANUAL: parseManualPayload
};

/** One human sentence per unknown reason, for a surface that wants to say why. */
export const contractUnknownSentence: Readonly<Record<ContractUnknownReason, string>> = {
  no_payload: "No response was read, so this provider's usage is unknown.",
  unknown_provider: "This build has no reader for this provider, so its usage is unknown.",
  shape_mismatch:
    "The provider answered, but not in a shape this build understands, so its " +
    "usage is unknown rather than guessed.",
  no_believable_meter:
    "The provider answered, but nothing in the answer was a usage reading this " +
    "build could believe, so its usage is unknown."
};

/**
 * Run a provider response through its parser and return an explicit outcome.
 *
 * `payload` is whatever was read for the provider: a parsed JSON object for
 * every provider except OpenCode, whose payload is the raw HTML string. A
 * missing payload is unknown, a shape the parser refuses is unknown, and a
 * shape that parses but survives normalization as nothing is unknown. Only a
 * response that both parses and yields at least one believable reading is ok.
 */
export function checkProviderContract(
  provider: ProviderCode,
  payload: unknown,
  now: string
): ContractOutcome {
  const parser = PARSER_BY_PROVIDER[provider];
  if (parser === undefined) {
    return { status: "unknown", provider, reason: "unknown_provider" };
  }
  if (payload === undefined || payload === null) {
    return { status: "unknown", provider, reason: "no_payload" };
  }
  const meters = parser(payload, now);
  if (meters === null) {
    return { status: "unknown", provider, reason: "shape_mismatch" };
  }
  /* A shape can parse and still carry nothing believable once the core
     normalizer has its say. That is unknown too, and stating it here stops a
     caller from treating an empty but non null list as a silent success. */
  if (normalizeMeters(meters).length === 0) {
    return { status: "unknown", provider, reason: "no_believable_meter" };
  }
  return { status: "ok", provider, meters };
}

/** Whether an outcome is the visible unknown state, for a caller that branches. */
export function isContractUnknown(
  outcome: ContractOutcome
): outcome is Extract<ContractOutcome, { status: "unknown" }> {
  return outcome.status === "unknown";
}
