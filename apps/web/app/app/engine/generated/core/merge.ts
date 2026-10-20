/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import type { Snapshot } from "./types";

/** Hard ceiling on how many snapshots one cache file may carry. */
export const MAX_CACHE_ENTRIES = 64;

/*
 * A provider code, a meter name and an account id are all closed identifiers
 * with no spaces, so joining them with one space cannot collide.
 *
 * The account id joins the key only when the row states one. A row without an
 * account therefore keys exactly as it always did, which is what lets a cache
 * written before accounts existed merge with one written after without any row
 * changing identity or duplicating itself. Two rows for the same meter under
 * different accounts are two rows, which is the whole point of the field.
 */
export function snapshotIdentity(snapshot: Snapshot): string {
  const base = snapshot.provider + " " + snapshot.meter;
  return snapshot.accountId === undefined ? base : base + " " + snapshot.accountId;
}

const identity = snapshotIdentity;

function compareIdentity(left: Snapshot, right: Snapshot): number {
  const leftKey = identity(left);
  const rightKey = identity(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function observedMilliseconds(snapshot: Snapshot): number {
  const parsed = Date.parse(snapshot.observedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Two resets at most this far apart name one window: consecutive Claude
 * windows reset hours apart at the least, while the status line (epoch
 * seconds) and the poll (a finer instant) disagree by under a second.
 * Rust twin: native_snapshot.rs SAME_WINDOW_MILLISECONDS.
 */
export const SAME_WINDOW_MILLISECONDS = 3_600_000;

/**
 * Whether a reading is known to be new at its observation time (2.1.6): the
 * row's own `certain`, else certain only for a poll row. Rust twin:
 * native_snapshot.rs is_certain.
 */
export function isCertainReading(snapshot: Snapshot): boolean {
  return snapshot.certain ?? snapshot.provenance?.sourceKind === "remote_api";
}

function isClaudeWindow(snapshot: Snapshot): boolean {
  return snapshot.provider === "CLAUDE" &&
    (snapshot.meter === "FIVE_HOUR" || snapshot.meter.startsWith("SEVEN_DAY"));
}

/**
 * How a reading compares with the row it would replace, by content alone
 * (2.1.6). Only a Claude rate limit window has such an order. Inside one
 * window usage only grows unless a reset intervenes, so a higher value is
 * newer; a later reset is a new window and an earlier one an old window.
 * Positive is newer, negative older, and zero is a question content cannot
 * answer (an equal value, a row without a reset, any other meter or
 * provider). A marker (availability) changes nothing: a marked row still
 * holds its last reading. Rust twin: native_snapshot.rs content_order.
 */
export function contentOrder(current: Snapshot, incoming: Snapshot): number {
  if (!isClaudeWindow(incoming)) return 0;
  const held = Date.parse(current.resetAt ?? "");
  const reset = Date.parse(incoming.resetAt ?? "");
  if (!Number.isFinite(held) || !Number.isFinite(reset)) return 0;
  if (Math.abs(reset - held) > SAME_WINDOW_MILLISECONDS) return Math.sign(reset - held);
  return Math.sign(incoming.value - current.value);
}

/**
 * Which of two readings of one meter is newer, the one rule every merge
 * applies (2.1.6). Positive is newer, negative older, and zero a tie that
 * each merge settles its own way.
 *
 * Two readings of one Claude window go by certainty first: two certain ones
 * by observation time, so a genuine reset (Settings, Usage) lowers the bar,
 * with the higher value at identical times; an uncertain one never overrides
 * a certain row; a certain one observed before an uncertain row wins only
 * with a higher value, and at or after it wins; two uncertain ones by content
 * (`contentOrder`), the later observation where content is equal, so an
 * equal value refreshes the age and a lower one refreshes nothing. A new or
 * an old window, a row without a reset, and every other meter or provider go
 * by `contentOrder`, then time. Markers never change the order. Shared
 * vectors: contracts/claude-poll-vectors.json `order`. Rust twin:
 * native_snapshot.rs reading_order.
 */
export function readingOrder(current: Snapshot, incoming: Snapshot): number {
  const time = Math.sign(observedMilliseconds(incoming) - observedMilliseconds(current));
  const content = contentOrder(current, incoming);
  const held = Date.parse(current.resetAt ?? "");
  const reset = Date.parse(incoming.resetAt ?? "");
  const window = isClaudeWindow(incoming) && Math.abs(reset - held) <= SAME_WINDOW_MILLISECONDS;
  if (!window) return content || time;
  const certain = isCertainReading(current);
  if (!isCertainReading(incoming)) return certain ? -1 : content || time;
  if (certain) return time || content;
  return time >= 0 || content > 0 ? 1 : -1;
}

function isClaudeStatuslineFallback(snapshot: Snapshot): boolean {
  return snapshot.provider === "CLAUDE" &&
    snapshot.accountId === undefined &&
    snapshot.provenance?.sourceKind === "statusline_payload" &&
    snapshot.provenance.observedVia === "claude_code_statusline";
}

function isClaudePayloadWeekly(snapshot: Snapshot): boolean {
  return snapshot.provider === "CLAUDE" && snapshot.meter.startsWith("SEVEN_DAY") &&
    snapshot.provenance?.sourceKind === "statusline_payload";
}

function scopedClaudeCoversFallback(
  candidate: Snapshot,
  snapshots: readonly Snapshot[]
): boolean {
  if (!isClaudeStatuslineFallback(candidate)) return false;
  const fallbackObserved = observedMilliseconds(candidate);
  return snapshots.some((snapshot) =>
    snapshot.provider === "CLAUDE" &&
    snapshot.meter === candidate.meter &&
    snapshot.accountId !== undefined &&
    Date.parse(snapshot.expiresAt) > fallbackObserved
  );
}

/**
 * Combine cached snapshots with freshly observed ones.
 *
 * One provider and meter pair holds exactly one snapshot. An incoming snapshot
 * replaces the cached snapshot for that pair unless it is the older reading
 * (`readingOrder`; a tie goes to the incoming one), every other cached row
 * survives, and the result stays bounded by dropping the least recently
 * observed rows.
 */
export function mergeSnapshots(
  existing: readonly Snapshot[],
  incoming: readonly Snapshot[],
  limit = MAX_CACHE_ENTRIES
): Snapshot[] {
  const byIdentity = new Map<string, Snapshot>();
  for (const snapshot of existing) {
    if (!isClaudePayloadWeekly(snapshot)) byIdentity.set(identity(snapshot), snapshot);
  }
  for (const snapshot of incoming) {
    if (isClaudePayloadWeekly(snapshot)) continue;
    const previous = byIdentity.get(identity(snapshot));
    if (previous === undefined || readingOrder(previous, snapshot) >= 0) {
      byIdentity.set(identity(snapshot), snapshot);
    }
  }
  const combined = [...byIdentity.values()];
  const merged = combined.filter(
    (snapshot) => !scopedClaudeCoversFallback(snapshot, combined)
  );
  if (merged.length <= limit) return merged.sort(compareIdentity);
  return merged
    .sort((left, right) => observedMilliseconds(right) - observedMilliseconds(left))
    .slice(0, limit)
    .sort(compareIdentity);
}
