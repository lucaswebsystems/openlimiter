/**
 * How often a terminal may ask a provider anything, and how long it stays away
 * after being told to.
 *
 * The numbers are the desktop's, deliberately: two clients on one machine that
 * disagree about cadence are two clients that between them poll twice as often
 * as either intended, and the provider only sees the total. Mirrors
 * `apps/desktop/src-tauri/src/claude_oauth.rs` lines 20 to 23.
 *
 * The arithmetic here is pure. The caller supplies the clock, so a whole
 * backoff history replays to the same instants on every machine.
 */
import path from "node:path";
import {
  MAX_JSON_FILE_BYTES,
  readJsonFileSafely,
  resolveStateDirectory,
  writeFileAtomically
} from "../cache.js";
import { canonicalJson } from "../normalizer.js";
import type { AcquisitionOutcome } from "./transport.js";

/** The ordinary interval between two reads of one provider. */
export const ACQUISITION_INTERVAL_SECONDS = 900;

/** How long a rate limited provider is left alone. */
export const ACQUISITION_RATE_LIMIT_BACKOFF_SECONDS = 3_600;

/** How long a provider that refused this client outright is left alone. */
export const ACQUISITION_BLOCKED_BACKOFF_SECONDS = 86_400;

/**
 * How long a desktop write keeps the command line tool from polling.
 *
 * The same fifteen minutes as one poll interval, because that is exactly the
 * claim being made: a desktop that wrote inside the last interval is the
 * refresher on this machine, and a second poll would only duplicate its work.
 */
export const DESKTOP_OWNERSHIP_SECONDS = 900;

/** File the per provider schedule is kept in, beside the cache. */
export const ACQUISITION_STATE_FILE_NAME = "openlimiter-acquisition.json";

/** Document version of the schedule file. */
export const ACQUISITION_STATE_VERSION = 1;

export interface AcquisitionProviderSchedule {
  /** When the last attempt was made. */
  readonly lastAttemptAt: string;
  /** The earliest instant the next attempt may be made. */
  readonly nextAttemptAt: string;
  /** What the last attempt achieved. */
  readonly outcome: AcquisitionOutcome;
}

export type AcquisitionSchedule = Readonly<
  Record<string, AcquisitionProviderSchedule>
>;

/**
 * How long to wait after an attempt with this outcome.
 *
 * A provider that told us to go away is obeyed and then some: its Retry-After
 * is a floor under our own backoff, never a replacement for it, so a header
 * asking for less than our interval cannot talk us into polling sooner.
 */
export function backoffSecondsFor(
  outcome: AcquisitionOutcome,
  retryAfterSeconds: number | null = null
): number {
  /* A provider that serves a field only to its own tools will answer the same
     way in fifteen minutes, so that outcome waits a day like a refusal does.
     Retrying it on the ordinary interval would be ninety six pointless requests
     a day against an answer that cannot change until we change. */
  const base = outcome === "rate_limited"
    ? ACQUISITION_RATE_LIMIT_BACKOFF_SECONDS
    : outcome === "blocked" || outcome === "identity_refused"
      ? ACQUISITION_BLOCKED_BACKOFF_SECONDS
      : ACQUISITION_INTERVAL_SECONDS;
  if (
    retryAfterSeconds === null ||
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds <= 0
  ) return base;
  return Math.max(base, Math.min(retryAfterSeconds, ACQUISITION_BLOCKED_BACKOFF_SECONDS));
}

/** The instant an attempt with this outcome earns, or null on an unread clock. */
export function nextAttemptInstant(
  outcome: AcquisitionOutcome,
  now: string,
  retryAfterSeconds: number | null = null
): string | null {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return null;
  const instant = new Date(
    current + backoffSecondsFor(outcome, retryAfterSeconds) * 1_000
  );
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

/**
 * Whether a provider may be read now.
 *
 * No schedule at all is due, which is what makes a first run work. A schedule
 * this build cannot read is also due, because the alternative is a provider
 * that never refreshes again on the strength of one unreadable value, and the
 * first successful attempt replaces it with a readable one.
 */
export function isProviderDue(
  schedule: AcquisitionProviderSchedule | undefined,
  now: string
): boolean {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return false;
  if (schedule === undefined) return true;
  const next = Date.parse(schedule.nextAttemptAt);
  if (!Number.isFinite(next)) return true;
  return current >= next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

const outcomeNames = new Set<string>([
  "ok",
  "unauthorized",
  "rate_limited",
  "blocked",
  "remote_error",
  "transport",
  "too_large",
  "drift",
  "identity_refused"
]);

/** Providers a schedule document may name, bounded so a file cannot grow forever. */
export const MAX_SCHEDULE_ENTRIES = 32;

/**
 * Read the schedule file.
 *
 * Every failure is an empty schedule rather than an exception: a schedule this
 * build cannot read means every provider is due, which is the same place a
 * fresh machine starts from and is never worse than not refreshing at all.
 */
export async function readAcquisitionSchedule(
  directory = resolveStateDirectory()
): Promise<AcquisitionSchedule> {
  const document = await readJsonFileSafely(
    path.join(directory, ACQUISITION_STATE_FILE_NAME),
    MAX_JSON_FILE_BYTES
  );
  if (!document.ok || !isRecord(document.value)) return {};
  const version = document.value["version"];
  if (version !== undefined && version !== ACQUISITION_STATE_VERSION) return {};
  const providers = document.value["providers"];
  if (!isRecord(providers)) return {};
  const schedule: Record<string, AcquisitionProviderSchedule> = {};
  for (const key of Object.keys(providers).slice(0, MAX_SCHEDULE_ENTRIES)) {
    const entry = providers[key];
    if (!isRecord(entry)) continue;
    const lastAttemptAt = entry["lastAttemptAt"];
    const nextAttemptAt = entry["nextAttemptAt"];
    const outcome = entry["outcome"];
    if (!isIsoInstant(lastAttemptAt) || !isIsoInstant(nextAttemptAt)) continue;
    if (typeof outcome !== "string" || !outcomeNames.has(outcome)) continue;
    schedule[key] = {
      lastAttemptAt,
      nextAttemptAt,
      outcome: outcome as AcquisitionOutcome
    };
  }
  return schedule;
}

/**
 * Replace the schedule file.
 *
 * Written atomically like every other state document, so a status line reading
 * it while a refresh writes it sees one version or the other and never half of
 * one. It carries no credential, no address and no response, only three fields
 * per provider.
 */
export async function writeAcquisitionSchedule(
  schedule: AcquisitionSchedule,
  directory = resolveStateDirectory()
): Promise<void> {
  await writeFileAtomically(
    path.join(directory, ACQUISITION_STATE_FILE_NAME),
    canonicalJson({ providers: schedule, version: ACQUISITION_STATE_VERSION })
  );
}

/**
 * One sentence per outcome, for the row a person reads.
 *
 * The backoff instant is rendered beside it by the caller; these sentences say
 * what happened, in words that do not need the reader to know HTTP.
 */
export const ACQUISITION_OUTCOME_SENTENCE:
  Readonly<Record<AcquisitionOutcome, string>> = {
  ok: "read",
  unauthorized: "the provider refused this login, open its own tool once to refresh it",
  rate_limited: "the provider asked for fewer requests, so this one is waiting",
  blocked: "the provider refused this client, so this one is waiting a day",
  remote_error: "the provider could not answer this time",
  transport: "this machine could not reach the provider",
  too_large: "the provider's answer was larger than this build accepts",
  drift: "the provider answered in a shape this build does not understand",
  identity_refused: "the provider serves this reading only to its own tools"
};
