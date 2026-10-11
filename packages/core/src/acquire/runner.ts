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
import { acquireMachineLease, recordAcquisitionAvailability, withPolicyFreshness, type MachineLease } from "../cache.js";
import type { ProviderCode, RawMeter, Snapshot } from "../types.js";
import {
  ACQUISITION_OUTCOME_SENTENCE,
  isProviderDue,
  nextAttemptInstant,
  nextSuccessInstant,
  type AcquisitionPhase,
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
import { acquisitionAccountId, credentialRevision } from "./identity.js";

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
 * Most providers have exactly one. Code Assist has two, because the
 * first answers with the companion project the second has to be scoped to.
 */
export type AcquisitionStep = (
  context: AcquisitionStepContext
) => AcquisitionStepResult | null;

export interface AcquisitionSpec {
  /** The provider code the resulting rows carry. */
  readonly provider: ProviderCode;
  /** Whose stored credential this read uses. */
  readonly credentialProvider: AcquisitionProvider;
  readonly steps: readonly AcquisitionStep[];
  /** The connector parser for this provider's response, injected by the caller. */
  readonly parse: (payload: unknown, now: string) => readonly RawMeter[] | null;
  /**
   * Whether a response stated its whole set (Claude: its weekly set). The ok
   * report carries the answer, and only a complete read may remove a stored
   * row it no longer reports (hotfix 2.1.5 fix 4).
   */
  readonly complete?: (payload: unknown, now: string) => boolean;
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
  /** The account identity these rows carry when the credential decides it. */
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
  readonly availability?: "expired_credentials" | "access_denied" | "quota_unavailable" | "rate_limited";
  readonly retryAt?: string;
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
  readonly clock?: () => number;
  readonly stateDirectory?: string;
  readonly lease?: MachineLease;
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
  readonly expiredCredentials?: boolean;
  readonly missingCredential?: boolean;
  readonly outcome: AcquisitionOutcome;
  readonly meters: readonly RawMeter[];
  readonly retryAfterSeconds: number | null;
  /** What `spec.complete` said about the answer, when the spec asks. */
  readonly complete?: boolean;
  /** Where a failed attempt stopped; asking, or reading the answer. */
  readonly phase?: "request" | "parse";
}

/**
 * A thrown failure as a code: a system error code or an error class name.
 * Never the message, which can carry a path, a header or a token.
 */
export function errorClassOf(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^E[A-Z0-9_]{1,30}$/u.test(code)) return code;
  const name = error instanceof Error ? error.name : "";
  return /^[A-Z][A-Za-z]{0,26}Error$/u.test(name) ? name : "exception";
}

export function credentialExpired(credential: AcquiredCredential, now: number): boolean {
  if (credential.expiresAtMilliseconds !== null && credential.expiresAtMilliseconds <= now) return true;
  try {
    const part = credential.secret.split(".")[1];
    if (!part) return false;
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp * 1000 <= now;
  } catch { return false; }
}

async function attempt(
  spec: AcquisitionSpec,
  credential: AcquiredCredential,
  options: AcquisitionRunOptions
): Promise<Attempt> {
  const previous: unknown[] = [];
  const started = Date.now();
  let retryAfter: number | null = null;
  for (const step of spec.steps) {
    const at = options.clock?.() ?? Date.parse(options.now) + Date.now() - started;
    if (credentialExpired(credential, at)) {
      return { outcome: "unauthorized", meters: [], retryAfterSeconds: null, expiredCredentials: true };
    }
    if (options.lease && !(await options.lease.stillOwned(at))) {
      return { outcome: "transport", meters: [], retryAfterSeconds: null, phase: "request" };
    }
    const decided = step({ credential, previous });
    if (decided === null) {
      return { outcome: "drift", meters: [], retryAfterSeconds: null, phase: "request" };
    }
    if ("stop" in decided) {
      return { outcome: decided.stop, meters: [], retryAfterSeconds: retryAfter, phase: "request" };
    }
    const request = decided;
    let reply;
    try {
      reply = await options.transport(request);
    } catch {
      /* The error object is never inspected and never formatted. A transport
         failure carries a URL and sometimes a header, and neither belongs
         anywhere near a row a person reads. */
      return { outcome: "transport", meters: [], retryAfterSeconds: null, phase: "request" };
    }
    /* A response that comes back after another process took the shared lease
       is that process's read now, so this one is dropped unwritten (hotfix
       2.1.5 fix 5). Rust twin: claude_oauth.rs collect_with_reread. */
    const answeredAt = options.clock?.() ?? Date.parse(options.now) + Date.now() - started;
    if (options.lease && !(await options.lease.stillOwned(answeredAt))) {
      return { outcome: "transport", meters: [], retryAfterSeconds: null, phase: "request" };
    }
    retryAfter = reply.retryAfterSeconds;
    if (reply.missingCredential === true) {
      return { outcome: "transport", meters: [], retryAfterSeconds: null, phase: "request", missingCredential: true };
    }
    if (reply.status === 0) {
      return { outcome: "too_large", meters: [], retryAfterSeconds: retryAfter, phase: "request" };
    }
    const outcome = reply.outcome ?? outcomeForStatus(reply.status);
    if (outcome !== "ok") return { outcome, meters: [], retryAfterSeconds: retryAfter, phase: "request" };
    let body: unknown;
    try {
      body = JSON.parse(reply.body) as unknown;
    } catch {
      return { outcome: "drift", meters: [], retryAfterSeconds: retryAfter, phase: "parse" };
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
  let complete: boolean | undefined;
  try {
    meters = spec.parse(payload, options.now);
    complete = spec.complete?.(payload, options.now);
  } catch {
    return { outcome: "drift", meters: [], retryAfterSeconds: retryAfter, phase: "parse" };
  }
  if (meters === null || meters.length === 0) {
    return { outcome: "drift", meters: [], retryAfterSeconds: retryAfter, phase: "parse" };
  }
  return { outcome: "ok", meters, retryAfterSeconds: retryAfter, ...(complete === undefined ? {} : { complete }) };
}

/**
 * Run every spec once, honouring the schedule.
 *
 * The returned schedule is the one to persist. A provider that is off keeps
 * the schedule it had. A provider whose local credential is absent, expired or
 * unreadable loses its entry: nothing was asked of the provider, so an old
 * outcome (yesterday's drift) must not read as today's. Every failure records
 * its own instant, the phase it happened in and a code, never a message.
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
  const credentialReader = options.readCredential ??
    ((provider: AcquisitionProvider) =>
      readAcquisitionCredential(provider, {
        ...options.lookup,
        now: options.now
      }));
  const readCredential = credentialReader;
  /* The login on disk right now, named the way a refusal names the login it
     refused. A login that cannot be read releases nothing. */
  const revisionNow = async (spec: AcquisitionSpec): Promise<string | undefined> => {
    const credential = await readCredential(spec.credentialProvider);
    return credential.ok ? credentialRevision(credential.credential.secret) : undefined;
  };
  /* Where the provider being read is right now, for the outer catch. */
  let phase: AcquisitionPhase = "credential";
  const failure = (failedIn: AcquisitionPhase, outcome: AcquisitionOutcome) =>
    outcome === "ok" ? {} : { phase: failedIn, errorClass: outcome };
  /* Outcomes that wait a day and belong to the credential itself, so a new
     credential releases them: a retired plan is one of those (Astra, 2026-10-01). */
  const refused = (outcome: AcquisitionOutcome) => outcome === "unauthorized" || outcome === "blocked" || outcome === "identity_refused" || outcome === "quota_unavailable";
  const outcomeAvailability = (outcome: AcquisitionOutcome) => outcome === "quota_unavailable"
    ? { availability: "quota_unavailable" as const }
    : outcome === "unauthorized"
    ? { availability: "expired_credentials" as const }
    : outcome === "blocked" || outcome === "identity_refused" ? { availability: "access_denied" as const } : {};
  /**
   * One provider, start to finish.
   *
   * Split out of the loop so the loop can wrap it. Everything in here can
   * throw: a credential reader, an injected transport, a parser, a clock. Six
   * healthy providers must not go unread because a seventh surprised us.
   */
  const readOne = async (spec: AcquisitionSpec): Promise<void> => {
    const existing = schedule[spec.provider];
    phase = "credential";
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
    const current = existing?.refusalRevision !== undefined && refused(existing.outcome)
      ? await revisionNow(spec)
      : undefined;
    const changedRefusal = current !== undefined && current !== existing?.refusalRevision;
    if (!isProviderDue(existing, options.now) && !changedRefusal) {
      rows.push({
        provider: spec.provider,
        detected: true,
        status: "waiting",
        ...(existing ? outcomeAvailability(existing.outcome) : {}),
        reason: existing === undefined
          ? null
          : ACQUISITION_OUTCOME_SENTENCE[existing.outcome],
        nextAttemptAt: existing?.nextAttemptAt ?? null,
        disclosure: spec.disclosure
      });
      return;
    }
    phase = "credential";
    const credential = await readCredential(spec.credentialProvider);
    if (!credential.ok) {
      const absent = credential.reason === "absent";
      delete schedule[spec.provider];
      rows.push({
        ...(credential.reason === "expired" ? { availability: "expired_credentials" as const } : {}),
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
    if (credentialExpired(held, Date.parse(options.now))) {
      delete schedule[spec.provider];
      rows.push({ provider: spec.provider, detected: true, status: "stale", accountId: acquisitionAccountId(spec.provider, held), availability: "expired_credentials", reason: CREDENTIAL_FAILURE_SENTENCE.expired, nextAttemptAt: null, disclosure: spec.disclosure });
      return;
    }
    const sentence = (outcome: AcquisitionOutcome): string =>
      spec.outcomeSentence?.[outcome] ?? ACQUISITION_OUTCOME_SENTENCE[outcome];
    phase = "request";
    /* The login every request of this read actually carried. */
    let sent = held;
    let result = await attempt(spec, sent, options);
    /*
     * A 401 can race the vendor's own tool refreshing its login: the token
     * sent lapsed a moment before the new one reached the store. When the
     * store now holds another login, it is asked once more before anything is
     * recorded against the old one. Rust twin: claude_oauth.rs,
     * collect_with_reread.
     */
    if (result.outcome === "unauthorized" && result.expiredCredentials !== true && result.missingCredential !== true) {
      phase = "credential";
      const reread = await readCredential(spec.credentialProvider);
      phase = "request";
      if (reread.ok && reread.credential.secret !== sent.secret &&
          !credentialExpired(reread.credential, Date.parse(options.now))) {
        sent = reread.credential;
        result = await attempt(spec, sent, options);
      }
    }
    const accountId = spec.accountIdFor?.(sent) ?? acquisitionAccountId(spec.provider, sent);
    const accountLabel = spec.accountLabelFor?.(sent) ?? null;
    const disclosure = spec.disclosureFor?.(sent) ?? spec.disclosure;
    if (result.missingCredential === true) {
      delete schedule[spec.provider];
      rows.push({
        provider: spec.provider,
        detected: false,
        status: "not_detected",
        reason: CREDENTIAL_FAILURE_SENTENCE.absent,
        nextAttemptAt: null,
        disclosure
      });
      return;
    }
    if (result.expiredCredentials) {
      delete schedule[spec.provider];
      rows.push({ provider: spec.provider, detected: true, status: "stale", accountId: acquisitionAccountId(spec.provider, sent), availability: "expired_credentials", reason: CREDENTIAL_FAILURE_SENTENCE.expired, nextAttemptAt: null, disclosure });
      return;
    }
    const snapshots: readonly Snapshot[] = result.outcome === "ok"
      ? normalizeMeters(
          accountId === null
            ? stamp(result.meters, sent)
            : stamp(result.meters, sent).map((entry) => ({
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
    const attemptedAt = options.clock ? new Date(options.clock()).toISOString() : options.now;
    /* A believed read is next due by its provider's own rule, Claude's reset
       aligned five minutes included; every failure keeps its backoff. */
    const nextAttemptAt = believed
      ? nextSuccessInstant(spec.provider, attemptedAt, snapshots.map((row) => row.resetAt))
      : nextAttemptInstant(
          result.outcome,
          attemptedAt,
          result.retryAfterSeconds,
          existing?.attempts ?? options.lease?.attempts ?? 0
        );
    schedule[spec.provider] = {
      attempts: result.outcome === "ok" ? 0 : (existing?.attempts ?? options.lease?.attempts ?? 0) + 1,
      lastAttemptAt: options.now,
      nextAttemptAt: nextAttemptAt ?? options.now,
      outcome: result.outcome,
      ...failure(result.phase ?? "request", result.outcome)
    };
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
        snapshots,
        ...(result.complete === undefined ? {} : { complete: result.complete })
      });
      return;
    }
    const outcome: AcquisitionOutcome = result.outcome === "ok"
      ? "drift"
      : result.outcome;
    schedule[spec.provider] = {
      attempts: (existing?.attempts ?? options.lease?.attempts ?? 0) + 1,
      /* The refusal names the login that was refused, never one that reached
         the store after the request went out. */
      ...(refused(outcome) ? { refusalRevision: credentialRevision(sent.secret) } : {}),
      lastAttemptAt: options.now,
      nextAttemptAt: nextAttemptAt ?? options.now,
      outcome,
      ...failure(result.outcome === "ok" ? "parse" : result.phase ?? "request", outcome)
    };
    rows.push({
      provider: spec.provider,
      ...(accountId === null ? {} : { accountId }),
      detected: true,
      status: "stale",
      ...(outcome === "rate_limited" && nextAttemptAt ? { availability: "rate_limited" as const, retryAt: nextAttemptAt } : outcomeAvailability(outcome)),
      reason: sentence(outcome),
      nextAttemptAt,
      disclosure
    });
  };

  for (const spec of specs) {
    let lease: MachineLease | null = null;
    try {
      if (options.stateDirectory !== undefined && spec.enabled !== false) {
        phase = "lease";
        lease = await acquireMachineLease(spec.provider, options.stateDirectory, options.clock?.() ?? Date.parse(options.now), await revisionNow(spec));
        if (lease === null) {
          rows.push({ provider: spec.provider, detected: true, status: "waiting", reason: "another acquisition owns this provider or its retry deadline is pending", nextAttemptAt: null, disclosure: spec.disclosure });
          continue;
        }
        // Read and persist each provider while its shared machine lease is held.
        const { stateDirectory: _directory, ...localOptions } = options;
        const previous = schedule[spec.provider];
        const localSchedule = previous ? { ...schedule, [spec.provider]: { ...previous, attempts: Math.max(previous.attempts ?? 0, lease.attempts) } } : schedule;
        const single = await runAcquisition([spec], { ...localOptions, readCredential, now: options.clock ? new Date(options.clock()).toISOString() : options.now, schedule: localSchedule, lease });
        rows.push(...single.rows);
        const updated = single.schedule[spec.provider];
        if (updated) schedule[spec.provider] = updated;
        else delete schedule[spec.provider];
        phase = "persist";
        const entry = schedule[spec.provider];
        if (entry) await lease.complete(Date.parse(entry.nextAttemptAt), entry.attempts ?? 0, entry.refusalRevision);
        /* Completing checked the lease is still ours, so only now may a
           report leave the round for the caller to write. */
        reports.push(...single.reports);
        for (const row of single.rows) {
          if (row.availability) await recordAcquisitionAvailability(spec.provider, row.availability, options.now, row.retryAt, options.stateDirectory, row.accountId);
        }
      } else {
        await readOne(spec);
      }
    } catch (error) {
      /*
       * The last line of defence. A provider that threw where nothing was
       * supposed to throw is that provider's drift, recorded on the ordinary
       * cadence, and the round carries on to everybody else. It is stamped
       * with its own instant, phase and code: five unrelated throws must not
       * read as one shared event at the round's start.
       */
      let failedAt = options.now;
      try {
        if (options.clock) failedAt = new Date(options.clock()).toISOString();
      } catch {
        /* A clock that throws too keeps the round's own instant. */
      }
      schedule[spec.provider] = {
        lastAttemptAt: failedAt,
        nextAttemptAt: nextAttemptInstant("drift", failedAt) ?? failedAt,
        outcome: "drift",
        phase,
        errorClass: errorClassOf(error)
      };
      rows.push({
        provider: spec.provider,
        detected: true,
        status: "stale",
        reason: ACQUISITION_OUTCOME_SENTENCE.drift,
        nextAttemptAt: null,
        disclosure: spec.disclosure
      });
    } finally {
      await lease?.release();
    }
  }
  return { rows, reports: reports.map((report) => report.ok ? { ...report, snapshots: report.snapshots.map(withPolicyFreshness) } : report), schedule };
}
