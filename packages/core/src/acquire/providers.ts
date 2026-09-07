/**
 * One acquisition specification per provider.
 *
 * Each is a credential source, a request or two, and the sentence its row
 * carries. The parser is handed in by the caller, because the parsers live one
 * package up. Nothing here decides whether a provider should be read: that is
 * cadence, coordination and configuration, and they are separate on purpose.
 */
import type { RawMeter } from "../types.js";
import type { AcquiredCredential } from "./credentials.js";
import type { AcquisitionSpec, AcquisitionStep } from "./runner.js";
import {
  claudeUsageRequest,
  codeAssistLoadRequest,
  codeAssistQuotaRequest,
  codexUsageRequest,
  grokBillingRequest,
  kimiUsageRequest,
  openrouterKeyRequest
} from "./transport.js";

export type PayloadParser = (
  payload: unknown,
  now: string
) => readonly RawMeter[] | null;

/**
 * The sentence each row carries about how its number was obtained.
 *
 * Every one of these credentials was issued to somebody else's client. That is
 * a thing a person is entitled to know before they rely on a bar, and it is the
 * same thing every honest reader of these endpoints says, so it is said here
 * once rather than implied.
 */
export const ACQUISITION_DISCLOSURE = {
  claude:
    "polls Anthropic with the token Claude Code stored on this machine, off " +
    "unless you turn it on",
  codex: "reads the login the Codex CLI stored, may break when OpenAI changes it",
  gemini:
    "reads the login the Gemini CLI stored, may break when Google changes it",
  antigravity:
    "reads the credential the Antigravity CLI stored, may break when Google " +
    "changes it",
  grok:
    "reads the login the Grok CLI stored, without the client marker xAI's own " +
    "tool sends, so this request is verified on the first install that has a " +
    "Grok login",
  antigravityShared:
    "shared Google Code Assist quota from the Gemini CLI login, not " +
    "Antigravity's own login",
  kimi: "reads the login the Kimi CLI stored, may break when Moonshot changes it",
  openrouter: "reads OpenRouter's documented key report with your own key"
} as const;

/** What the Code Assist bootstrap calls the project the quota read is scoped to. */
export const CODE_ASSIST_PROJECT_FIELD = "cloudaicompanionProject";

/** The account label a reading taken from the shared Gemini login carries. */
export const SHARED_CODE_ASSIST_ACCOUNT = "gemini-cli-shared";

/** What a surface should print for that account instead of the identifier. */
export const SHARED_CODE_ASSIST_LABEL = "Shared Google Code Assist quota";

/** The list a bootstrap carries when it answered and withheld the project. */
export const CODE_ASSIST_TIERS_FIELD = "allowedTiers";

/**
 * What the row says when Google withholds the companion project.
 *
 * Measured on 2026-09-07 on Lucas's own machine, read only: `loadCodeAssist`
 * answered 200 to a request identifying as OpenLimiter and returned
 * `allowedTiers` and `ineligibleTiers` and no `cloudaicompanionProject`, so
 * there is nothing to scope the quota read to. The desktop reaches the same
 * endpoint by claiming to be Google's own client
 * (`apps/desktop/src-tauri/src/net.rs` 273 to 285 records exactly this), which
 * Rule 1 forbids here. So the row states the fact rather than pretending the
 * response was malformed.
 *
 * This conclusion is drawn ONLY from that measured signature. A day of silence
 * bought on a guess would hide a provider that was merely having a bad
 * afternoon, so anything else, a timeout, a 500, a rate limit, or a body that
 * is not this, stays an ordinary transient failure on the ordinary cadence.
 */
export const CODE_ASSIST_IDENTITY_SENTENCE =
  "Google answers this quota only to its own tools, so it is read here only " +
  "when another tool on this machine has written it";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The two step Code Assist read, shared by Gemini CLI and Antigravity.
 *
 * The second step is scoped to the project the first one named. A bootstrap
 * that names no project produces no request, which the runner reads as a shape
 * this build did not understand rather than as a reason to ask anyway.
 */
export function codeAssistSteps(): readonly AcquisitionStep[] {
  return [
    ({ credential }) => codeAssistLoadRequest(credential.secret),
    ({ credential, previous }) => {
      const bootstrap = previous[0];
      /* Not an object at all is a shape this build does not understand. */
      if (!isRecord(bootstrap)) return null;
      const project = bootstrap[CODE_ASSIST_PROJECT_FIELD];
      if (typeof project === "string") {
        return codeAssistQuotaRequest(credential.secret, project);
      }
      /*
       * The measured signature and nothing else: a tier list present, a project
       * absent. That pairing is Google saying it knows who is asking and that
       * this field is not for them, and it earns the day long backoff. A
       * bootstrap missing BOTH fields is only a shape this build does not
       * understand, and it stays drift on the ordinary cadence so a provider
       * having a bad hour is never silenced for a day.
       */
      return Array.isArray(bootstrap[CODE_ASSIST_TIERS_FIELD])
        ? { stop: "identity_refused" }
        : null;
    }
  ];
}

/** The sentence overrides both Code Assist readers carry. */
const codeAssistSentences = {
  identity_refused: CODE_ASSIST_IDENTITY_SENTENCE
} as const;

export interface ClaudeSpecOptions {
  readonly parse: PayloadParser;
  /**
   * Whether the poll is on.
   *
   * Off by default and off in every code path that does not read a
   * configuration file. The documented status line payload is Claude's primary
   * source; this poll only exists for the hours Claude Code is closed, and a
   * person opts into it knowing what it does.
   */
  readonly enabled: boolean;
}

export function claudeSpec(options: ClaudeSpecOptions): AcquisitionSpec {
  return {
    provider: "CLAUDE",
    credentialProvider: "CLAUDE",
    steps: [({ credential }) => claudeUsageRequest(credential.secret)],
    parse: options.parse,
    disclosure: ACQUISITION_DISCLOSURE.claude,
    enabled: options.enabled,
    disabledReason:
      "the Anthropic poll is off, so this shows what Claude Code last reported"
  };
}

export function codexSpec(parse: PayloadParser): AcquisitionSpec {
  return {
    provider: "CODEX",
    credentialProvider: "CODEX",
    steps: [
      ({ credential }) => credential.accountId === null
        ? null
        : codexUsageRequest(credential.secret, credential.accountId)
    ],
    parse,
    disclosure: ACQUISITION_DISCLOSURE.codex
  };
}

export function geminiCliSpec(parse: PayloadParser): AcquisitionSpec {
  return {
    provider: "GEMINI_CLI",
    credentialProvider: "GEMINI_CLI",
    steps: codeAssistSteps(),
    parse,
    disclosure: ACQUISITION_DISCLOSURE.gemini,
    outcomeSentence: codeAssistSentences
  };
}

/** Whether this credential is the Gemini CLI's, borrowed for the shared quota. */
export function isSharedCodeAssist(credential: AcquiredCredential): boolean {
  return credential.origin === "shared_code_assist";
}

export function antigravitySpec(parse: PayloadParser): AcquisitionSpec {
  return {
    provider: "ANTIGRAVITY",
    credentialProvider: "ANTIGRAVITY",
    steps: codeAssistSteps(),
    parse,
    disclosure: ACQUISITION_DISCLOSURE.antigravity,
    outcomeSentence: codeAssistSentences,
    /* A reading taken from the Gemini CLI's file is filed under its own account
       label, so it can never be mistaken in the cache, on a bar or in a sync
       for a login the person made to Antigravity. */
    accountIdFor: (credential) =>
      isSharedCodeAssist(credential) ? SHARED_CODE_ASSIST_ACCOUNT : null,
    accountLabelFor: (credential) =>
      isSharedCodeAssist(credential) ? SHARED_CODE_ASSIST_LABEL : null,
    disclosureFor: (credential) =>
      isSharedCodeAssist(credential) ? ACQUISITION_DISCLOSURE.antigravityShared : null
  };
}

export function grokSpec(parse: PayloadParser): AcquisitionSpec {
  return {
    provider: "GROK",
    credentialProvider: "GROK",
    steps: [
      ({ credential }) => grokBillingRequest(credential.secret, credential.accountId)
    ],
    parse,
    disclosure: ACQUISITION_DISCLOSURE.grok
  };
}

export function kimiSpec(parse: PayloadParser): AcquisitionSpec {
  return {
    provider: "KIMI",
    credentialProvider: "KIMI",
    steps: [({ credential }) => kimiUsageRequest(credential.secret)],
    parse,
    disclosure: ACQUISITION_DISCLOSURE.kimi
  };
}

export function openrouterSpec(parse: PayloadParser): AcquisitionSpec {
  return {
    provider: "OPENROUTER",
    credentialProvider: "OPENROUTER",
    steps: [({ credential }) => openrouterKeyRequest(credential.secret)],
    parse,
    disclosure: ACQUISITION_DISCLOSURE.openrouter
  };
}
