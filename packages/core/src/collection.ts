import { mergeSnapshots, snapshotIdentity, MAX_CACHE_ENTRIES } from "./merge.js";
import type { ProviderCode, Snapshot } from "./types.js";
import { PROVIDER_CODES, ACCOUNT_ID_PATTERN } from "./types.js";

/**
 * What one collection run achieved, and what the cache does about it.
 *
 * The product's whole honesty problem in one file. A provider answering with a
 * 200 is not a reading, and a provider answering with a well formed body whose
 * meaning has changed is worse than a provider answering with nothing: the
 * first is visibly unknown, the second is confidently wrong. So a run reports
 * what it achieved rather than what it received, and drift is a first class
 * outcome with a first class consequence.
 *
 * That consequence is a SUPPRESSION. Removing the affected rows is not enough
 * on its own, because a cache is shared: the desktop, the command line tool,
 * the adapters and the dashboard all read it, and any one of them could write a
 * stale row back before the others noticed. A suppression is a standing
 * instruction in the document itself, so every reader on the machine reaches
 * the same unknown at the same instant, and a row that predates it can never
 * become visible again.
 *
 * Everything here is pure: no clock, no file system, no network. The caller
 * supplies the instant, so a whole history can be replayed and land on the same
 * answer every time.
 */

/**
 * Why a collection run produced nothing usable.
 *
 * `drift` is separated from every other reason on purpose, and is the only one
 * that suppresses. The rest are ordinary interruptions: the provider was busy,
 * the machine was offline, a credential lapsed. None of those say anything
 * about whether the reading we already hold is still true, so none of them
 * throws it away; the reading ages out through the ordinary freshness rule
 * instead. Drift is the one that says the previous reading's MEANING is in
 * doubt, and that cannot be waited out.
 */
export const COLLECTION_FAILURE_REASONS = [
  "drift",
  "network",
  "authentication",
  "rate_limited",
  "remote_error",
  "local_io"
] as const;

export type CollectionFailureReason = (typeof COLLECTION_FAILURE_REASONS)[number];

export type CollectionReport =
  | {
      ok: true;
      provider: ProviderCode;
      accountId?: string;
      observedAt: string;
      snapshots: readonly Snapshot[];
    }
  | {
      ok: false;
      provider: ProviderCode;
      accountId?: string;
      observedAt: string;
      reason: CollectionFailureReason;
    };

/**
 * A standing instruction to distrust one identity's cached rows.
 *
 * `reason` is a single literal rather than the full failure vocabulary,
 * deliberately: drift is the only failure that suppresses, and a type that
 * could hold "network" would invite a future caller to suppress on a dropped
 * packet, which would throw away a perfectly good reading every time a train
 * went into a tunnel.
 */
export interface CacheSuppression {
  provider: ProviderCode;
  accountId?: string;
  reason: "drift";
  suppressedAt: string;
}

/**
 * How many suppressions one cache document may carry.
 *
 * The same order of magnitude as the row bound, because there is at most one
 * suppression per identity and identities are what rows are keyed by. A
 * document claiming more than this is not a cache with a lot of drift, it is a
 * document somebody wrote by hand.
 */
export const MAX_CACHE_SUPPRESSIONS = MAX_CACHE_ENTRIES;

/** The cache as this module reasons about it: rows, and what to distrust. */
export interface CacheState {
  snapshots: readonly Snapshot[];
  suppressions: readonly CacheSuppression[];
}

/**
 * The one place provider and account identity is decided.
 *
 * A row, a report and a suppression all have to agree on what "the same thing"
 * means, and the way that goes wrong is three near identical comparisons in
 * three files, one of which forgets that an absent account is not the account
 * called "default". So there is one function, everything calls it, and an
 * absent account keys exactly as it always did.
 */
export function collectionIdentity(
  provider: ProviderCode,
  accountId?: string
): string {
  return accountId === undefined ? provider : provider + " " + accountId;
}

/** Whether this snapshot belongs to this provider and account. */
export function snapshotBelongsTo(
  snapshot: Snapshot,
  provider: ProviderCode,
  accountId?: string
): boolean {
  return (
    snapshot.provider === provider &&
    collectionIdentity(provider, snapshot.accountId) ===
      collectionIdentity(provider, accountId)
  );
}

function parseInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A suppression document as read back from disk.
 *
 * `ok: false` is not "there were none". It means the suppression data could not
 * be believed, and since a suppression is the only thing standing between a
 * stale row and a surface, a suppression list that cannot be read makes every
 * row in that document unknown. That is the fail closed direction: the cost of
 * being wrong here is showing a number that is no longer true, and the cost of
 * being right is one refresh cycle of honest unknown.
 */
export type SuppressionReadResult =
  | { ok: true; suppressions: CacheSuppression[] }
  | { ok: false };

function isProviderCode(value: unknown): value is ProviderCode {
  return (
    typeof value === "string" &&
    (PROVIDER_CODES as readonly string[]).includes(value)
  );
}

/**
 * Read the suppression list out of a cache document.
 *
 * Absent is the ordinary case and reads as an empty list: a document written
 * before suppressions existed has none, which is true. Anything present and
 * unreadable is refused whole rather than partially salvaged, because a
 * half read suppression list would silently un suppress whichever entries
 * failed to parse, which is exactly the value it exists to prevent.
 */
export function readSuppressions(value: unknown): SuppressionReadResult {
  if (value === undefined || value === null) return { ok: true, suppressions: [] };
  if (!Array.isArray(value)) return { ok: false };
  if (value.length > MAX_CACHE_SUPPRESSIONS) return { ok: false };
  const suppressions: CacheSuppression[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false };
    if (!isProviderCode(entry["provider"])) return { ok: false };
    if (entry["reason"] !== "drift") return { ok: false };
    const suppressedAt = entry["suppressedAt"];
    if (typeof suppressedAt !== "string" || parseInstant(suppressedAt) === null) {
      return { ok: false };
    }
    const accountId = entry["accountId"];
    if (accountId !== undefined) {
      if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
        return { ok: false };
      }
    }
    suppressions.push({
      provider: entry["provider"],
      reason: "drift",
      suppressedAt,
      ...(accountId === undefined ? {} : { accountId })
    });
  }
  return { ok: true, suppressions };
}

/**
 * Fold one collection report into the cache.
 *
 * Four rules, one per kind of outcome, and no fifth:
 *
 *   1. A successful report replaces every row for its identity and clears that
 *      identity's suppression. A provider that has started making sense again
 *      is trusted again, and only a real parse can say that.
 *   2. A drift report removes those rows and records the suppression, replacing
 *      any earlier one, so the instant always reflects the latest drift.
 *   3. Every other failure changes nothing at all. The rows we hold stay, and
 *      age out through the ordinary freshness rule.
 *   4. A report whose instant cannot be read is not applied. An unreadable
 *      instant cannot be compared with a row's observation, so it could neither
 *      suppress honestly nor be cleared honestly.
 */
export function applyCollectionReport(
  state: CacheState,
  report: CollectionReport
): CacheState {
  if (parseInstant(report.observedAt) === null) return state;
  const belongs = (snapshot: Snapshot): boolean =>
    snapshotBelongsTo(snapshot, report.provider, report.accountId);
  const suppressionMatches = (suppression: CacheSuppression): boolean =>
    suppression.provider === report.provider &&
    collectionIdentity(report.provider, suppression.accountId) ===
      collectionIdentity(report.provider, report.accountId);

  if (report.ok) {
    /* Rows for this identity are dropped before the merge rather than left for
       it, because a successful run that returns FEWER meters than last time
       must not leave the missing ones behind as fresh looking survivors. */
    const kept = state.snapshots.filter((snapshot) => !belongs(snapshot));
    return {
      snapshots: mergeSnapshots(kept, report.snapshots),
      suppressions: state.suppressions.filter(
        (suppression) => !suppressionMatches(suppression)
      )
    };
  }
  if (report.reason !== "drift") return state;
  const suppression: CacheSuppression = {
    provider: report.provider,
    reason: "drift",
    suppressedAt: report.observedAt,
    ...(report.accountId === undefined ? {} : { accountId: report.accountId })
  };
  const others = state.suppressions.filter(
    (existing) => !suppressionMatches(existing)
  );
  return {
    snapshots: state.snapshots.filter((snapshot) => !belongs(snapshot)),
    /* Bounded by dropping the oldest, so a machine that drifts on every
       provider for a month cannot grow the document without limit. */
    suppressions: boundSuppressions([...others, suppression])
  };
}

function suppressedMilliseconds(suppression: CacheSuppression): number {
  return parseInstant(suppression.suppressedAt) ?? 0;
}

function boundSuppressions(
  suppressions: readonly CacheSuppression[]
): CacheSuppression[] {
  if (suppressions.length <= MAX_CACHE_SUPPRESSIONS) return [...suppressions];
  return [...suppressions]
    .sort((left, right) => suppressedMilliseconds(right) - suppressedMilliseconds(left))
    .slice(0, MAX_CACHE_SUPPRESSIONS);
}

/**
 * The rows a surface may actually see.
 *
 * A row survives only when nothing suppresses its identity, or when it was
 * observed strictly AFTER the suppression that does. Strictly after, not at or
 * after: a row observed in the same millisecond as the drift that suppressed it
 * is the very row the drift was about.
 *
 * Every read goes through here, which is what makes drift instant everywhere.
 * `buildAdvice` is handed the result of this function and never the raw rows,
 * so a suppressed provider is reported unknown by the statusline, the agent
 * context, the dashboard and the tray in the same tick.
 */
export function visibleSnapshots(state: CacheState): Snapshot[] {
  if (state.suppressions.length === 0) return [...state.snapshots];
  return state.snapshots.filter((snapshot) => {
    const observed = parseInstant(snapshot.observedAt);
    for (const suppression of state.suppressions) {
      if (!snapshotBelongsTo(snapshot, suppression.provider, suppression.accountId)) {
        continue;
      }
      /* A row whose own observation cannot be read cannot be proven newer than
         the suppression, so it is not shown. */
      if (observed === null) return false;
      if (observed <= suppressedMilliseconds(suppression)) return false;
    }
    return true;
  });
}

/** Identity, exported for the cache writer that has to key rows the same way. */
export { snapshotIdentity };
