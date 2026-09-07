/**
 * One round of acquisition: read what is on this machine, ask each provider
 * once, and say plainly what happened to every one of them.
 *
 * The parsers are injected rather than imported. This package sits underneath
 * the connector package that owns them, and inverting that dependency to save
 * one argument would put a provider response shape in the same module as the
 * cache. So a caller wires its parsers in, and this file stays about cadence,
 * ordering and honesty.
 *
 * Nothing here throws. A round that fails every provider still returns a row
 * per provider saying why, because the surfaces above are a status line and a
 * doctor command, and both of them owe a person an answer rather than a stack.
 */
import type {
  CollectionFailureReason,
  CollectionReport
} from "../collection.js";
import { normalizeMeters } from "../normalizer.js";
import type { ProviderCode, RawMeter, Snapshot } from "../types.js";
import {
  ACQUISITION_OUTCOME_SENTENCE,
  isProviderDue,
  nextAttemptInstant,
  type AcquisitionProviderSchedule,
  type AcquisitionSchedule
} from "./cadence.js";
import {
  CREDENTIAL_FAILURE_SENTENCE,
  readAcquisitionCredential,
  type AcquiredCredential,
  type AcquisitionProvider,
  type CredentialLookupOptions,
  type CredentialResult
} from "./credentials.js";
import {
  outcomeForStatus,
  type AcquisitionOutcome,
  type AcquisitionRequest,
  type AcquisitionTransport
} from "./transport.js";

export interface AcquisitionStepContext {
  readonly credential: AcquiredCredential;
  /** The parsed bodies of the steps already taken, oldest first. */
  readonly previous: readonly unknown[];
}

/**
 * What a step decided to do.
 *
 * A request is the ordinary answer. `stop` is how a step reports an outcome it
 * can name precisely, which is what tells a bootstrap that answered 200 and
 * withheld the field the next hop needs apart from a bootstrap that arrived
 * mangled. Null remains the honest "I do not understand this".
 */
export type AcquisitionStepResult =
  | AcquisitionRequest
  | { readonly stop: AcquisitionOutcome };

/**
 * One request in a provider's read.
 *
 * Most providers have exactly one. The Code Assist pair has two, because the
 * first answers with the companion project the second has to be scoped to.
 */
export type AcquisitionStep = (
  context: AcquisitionStepContext
) => AcquisitionStepResult | null;

export interface AcquisitionSpec {
  /** The provider code the resulting rows carry. */
  readonly provider: ProviderCode;
  /** Whose stored credential this read uses. Antigravity borrows Gemini's file. */
  readonly credentialProvider: AcquisitionProvider;
  readonly steps: readonly AcquisitionStep[];
  /** The connector parser for this provider's response, injected by the caller. */
  readonly parse: (payload: unknown, now: string) => readonly RawMeter[] | null;
  /**
   * The one sentence this provider's row always carries, or null.
   *
   * Used where the way we read a provider is itself something a person should
   * know, which is every provider whose credential belongs to somebody else's
   * client.
   */
  readonly disclosure: string | null;
  /** False when a configuration switch turns this provider's poll off. */
  readonly enabled?: boolean;
  /** Why it is off, in the words the row prints. */
  readonly disabledReason?: string;
  /**
   * The account label these rows carry, when the credential decides it.
   *
   * Antigravity is the reason this exists. Reading the Gemini CLI's file is a
   * legitimate way to reach the shared Code Assist quota, and it is not
   * Antigravity's own login, so the rows are filed under an account that says
   * which it was rather than under the provider's unnamed default.
   */
  readonly accountIdFor?: (credential: AcquiredCredential) => string | null;
  /** The disclosure these rows carry, when the credential changes it. */
  readonly disclosureFor?: (credential: AcquiredCredential) => string | null;
  /** The human name for that account, for a surface that would print an id. */
  readonly accountLabelFor?: (credential: AcquiredCredential) => string | null;
  /** Sentences this provider says better than the shared vocabulary does. */
  readonly outcomeSentence?: Partial<Record<AcquisitionOutcome, string>>;
}

/** What one provider's row says after a round. */
export type AcquisitionStatus =
  | "read"
  | "stale"
  | "waiting"
  | "not_detected"
  | "off";

export interface AcquisitionRow {
  readonly provider: ProviderCode;
  /** The account these rows were filed under, when one was decided. */
  readonly accountId?: string;
  /** Whether a local credential for this provider was found at all. */
  readonly detected: boolean;
  readonly status: AcquisitionStatus;
  /** Why the row is not `read`, in a sentence with no dashes. */
  readonly reason: string | null;
  /** The earliest instant this provider will be asked again, when one is set. */
  readonly nextAttemptAt: string | null;
  readonly disclosure: string | null;
}

export interface AcquisitionRunResult {
  readonly rows: readonly AcquisitionRow[];
  /** Only the successful reads. A failure never rewrites the cache. */
  readonly reports: readonly CollectionReport[];
  readonly schedule: AcquisitionSchedule;
}

export interface AcquisitionRunOptions {
  readonly transport: AcquisitionTransport;
  readonly now: string;
  readonly schedule: AcquisitionSchedule;
  /** Where credentials are read from, injected so a test never reads a real one. */
  readonly readCredential?: (
    provider: AcquisitionProvider
  ) => Promise<CredentialResult>;
  readonly lookup?: CredentialLookupOptions;
  /**
   * What is stamped onto every meter before it is validated.
   *
   * Provenance and the writer marker are facts about HOW a reading arrived, and
   * only the command that ran the round knows them, so they are applied here
   * rather than invented by a parser.
   */
  readonly stamp?: (
    meters: readonly RawMeter[],
    credential: AcquiredCredential
  ) => readonly RawMeter[];
}

/**
 * The failure vocabulary the cache understands, from ours.
 *
 * Drift is deliberately NOT mapped through. In this codebase a drift report
 * suppresses every cached row for that provider, and the command line tool is
 * a second reader beside a status line that already writes Claude rows. A free
 * account whose usage document carries no windows would parse to nothing and
 * would then withdraw rows another source had every right to write. A failed
 * read leaves the cache exactly as it was and the row says what happened; only
 * a successful read changes anything.
 */
export function collectionReasonFor(
  outcome: AcquisitionOutcome
): CollectionFailureReason {
  if (outcome === "unauthorized") return "authentication";
  if (outcome === "rate_limited") return "rate_limited";
  if (outcome === "transport") return "network";
  return "remote_error";
}

interface Attempt {
  readonly outcome: AcquisitionOutcome;
  readonly meters: readonly RawMeter[];
  readonly retryAfterSeconds: number | null;
}

async function attempt(
  spec: AcquisitionSpec,
  credential: AcquiredCredential,
  options: AcquisitionRunOptions
): Promise<Attempt> {
  const previous: unknown[] = [];
  let retryAfter: number | null = null;
  for (const step of spec.steps) {
    const decided = step({ credential, previous });
    if (decided === null) {
      return { outcome: "drift", meters: [], retryAfterSeconds: null };
    }
    if ("stop" in decided) {
      return { outcome: decided.stop, meters: [], retryAfterSeconds: retryAfter };
    }
    const request = decided;
    let reply;
    try {
      reply = await options.transport(request);
    } catch {
      /* The error object is never inspected and never formatted. A transport
         failure carries a URL and sometimes a header, and neither belongs
         anywhere near a row a person reads. */
      return { outcome: "transport", meters: [], retryAfterSeconds: null };
    }
    retryAfter = reply.retryAfterSeconds;
    if (reply.status === 0) {
      return { outcome: "too_large", meters: [], retryAfterSeconds: retryAfter };
    }
    const outcome = outcomeForStatus(reply.status);
    if (outcome !== "ok") return { outcome, meters: [], retryAfterSeconds: retryAfter };
    let body: unknown;
    try {
      body = JSON.parse(reply.body) as unknown;
    } catch {
      return { outcome: "drift", meters: [], retryAfterSeconds: retryAfter };
    }
    previous.push(body);
  }
  const payload = previous[previous.length - 1];
  /*
   * A parser is a pure function that should answer null rather than throw, and
   * every one of ours does. This catch is here because ONE of them throwing
   * used to end the whole round: six healthy providers would go unread because
   * a seventh got a response nobody anticipated. A throw is that provider's
   * drift and nobody else's.
   */
  let meters: readonly RawMeter[] | null;
  try {
    meters = spec.parse(payload, options.now);
  } catch {
    return { outcome: "drift", meters: [], retryAfterSeconds: retryAfter };
  }
  if (meters === null || meters.length === 0) {
    return { outcome: "drift", meters: [], retryAfterSeconds: retryAfter };
  }
  return { outcome: "ok", meters, retryAfterSeconds: retryAfter };
}

/**
 * Run every spec once, honouring the schedule.
 *
 * The returned schedule is the one to persist. A provider that was not asked,
 * because it is off or because nothing on this machine belongs to it, keeps the
 * schedule it had: a person who installs Codex this afternoon should not have
 * to wait out a backoff that was recorded before Codex existed here.
 */
export async function runAcquisition(
  specs: readonly AcquisitionSpec[],
  options: AcquisitionRunOptions
): Promise<AcquisitionRunResult> {
  const rows: AcquisitionRow[] = [];
  const reports: CollectionReport[] = [];
  const schedule: Record<string, AcquisitionProviderSchedule> = {
    ...options.schedule
  };
  const stamp = options.stamp ?? ((meters: readonly RawMeter[]) => meters);
  const readCredential = options.readCredential ??
    ((provider: AcquisitionProvider) =>
      readAcquisitionCredential(provider, {
        ...options.lookup,
        now: options.now
      }));
  /**
   * One provider, start to finish.
   *
   * Split out of the loop so the loop can wrap it. Everything in here can
   * throw: a credential reader, an injected transport, a parser, a clock. Six
   * healthy providers must not go unread because a seventh surprised us.
   */
  const readOne = async (spec: AcquisitionSpec): Promise<void> => {
    const existing = schedule[spec.provider];
    if (spec.enabled === false) {
      rows.push({
        provider: spec.provider,
        detected: false,
        status: "off",
        reason: spec.disabledReason ?? "this provider's poll is off",
        nextAttemptAt: null,
        disclosure: spec.disclosure
      });
      return;
    }
    if (!isProviderDue(existing, options.now)) {
      rows.push({
        provider: spec.provider,
        detected: true,
        status: "waiting",
        reason: existing === undefined
          ? null
          : ACQUISITION_OUTCOME_SENTENCE[existing.outcome],
        nextAttemptAt: existing?.nextAttemptAt ?? null,
        disclosure: spec.disclosure
      });
      return;
    }
    const credential = await readCredential(spec.credentialProvider);
    if (!credential.ok) {
      const absent = credential.reason === "absent";
      rows.push({
        provider: spec.provider,
        detected: !absent,
        status: absent ? "not_detected" : "stale",
        reason: CREDENTIAL_FAILURE_SENTENCE[credential.reason],
        nextAttemptAt: null,
        disclosure: spec.disclosure
      });
      /* A local credential problem does not earn a network backoff. Nothing was
         asked of the provider, and the fix is on this machine. */
      return;
    }
    const held = credential.credential;
    const accountId = spec.accountIdFor?.(held) ?? null;
    const accountLabel = spec.accountLabelFor?.(held) ?? null;
    const disclosure = spec.disclosureFor?.(held) ?? spec.disclosure;
    const sentence = (outcome: AcquisitionOutcome): string =>
      spec.outcomeSentence?.[outcome] ?? ACQUISITION_OUTCOME_SENTENCE[outcome];
    const result = await attempt(spec, held, options);
    const nextAttemptAt = nextAttemptInstant(
      result.outcome,
      options.now,
      result.retryAfterSeconds
    );
    schedule[spec.provider] = {
      lastAttemptAt: options.now,
      nextAttemptAt: nextAttemptAt ?? options.now,
      outcome: result.outcome
    };
    const snapshots: readonly Snapshot[] = result.outcome === "ok"
      ? normalizeMeters(
          accountId === null
            ? stamp(result.meters, held)
            : stamp(result.meters, held).map((entry) => ({
                ...entry,
                accountId,
                /* A surface that would otherwise print the identifier gets a
                   sentence a person can read instead. */
                ...(accountLabel === null ? {} : { accountLabel })
              }))
        )
      : [];
    /* A read that parsed and then lost every row to validation has produced no
       reading, and saying otherwise would put an empty success on the row. */
    const believed = result.outcome === "ok" && snapshots.length > 0;
    if (believed) {
      rows.push({
        provider: spec.provider,
        ...(accountId === null ? {} : { accountId }),
        detected: true,
        status: "read",
        reason: null,
        nextAttemptAt,
        disclosure
      });
      reports.push({
        ok: true,
        provider: spec.provider,
        ...(accountId === null ? {} : { accountId }),
        observedAt: options.now,
        snapshots
      });
      return;
    }
    const outcome: AcquisitionOutcome = result.outcome === "ok"
      ? "drift"
      : result.outcome;
    schedule[spec.provider] = {
      lastAttemptAt: options.now,
      nextAttemptAt: nextAttemptAt ?? options.now,
      outcome
    };
    rows.push({
      provider: spec.provider,
      ...(accountId === null ? {} : { accountId }),
      detected: true,
      status: "stale",
      reason: sentence(outcome),
      nextAttemptAt,
      disclosure
    });
  };

  for (const spec of specs) {
    try {
      await readOne(spec);
    } catch {
      /*
       * The last line of defence. A provider that threw where nothing was
       * supposed to throw is that provider's drift, recorded on the ordinary
       * cadence, and the round carries on to everybody else.
       */
      schedule[spec.provider] = {
        lastAttemptAt: options.now,
        nextAttemptAt: nextAttemptInstant("drift", options.now) ?? options.now,
        outcome: "drift"
      };
      rows.push({
        provider: spec.provider,
        detected: true,
        status: "stale",
        reason: ACQUISITION_OUTCOME_SENTENCE.drift,
        nextAttemptAt: null,
        disclosure: spec.disclosure
      });
    }
  }
  return { rows, reports, schedule };
}
