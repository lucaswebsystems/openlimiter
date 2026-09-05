/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/*
 * The one connector reading an interface the provider documents itself.
 *
 * Everything below is written against the published Claude Code statusline
 * contract and against the usage document the same credential answers with,
 * both cited in full above parseClaudePayload.
 */
import type {
  ConnectionTool,
  ConnectorContract,
  ConnectorLabels,
  ConnectorResult,
  RawMeter,
  SnapshotAmounts,
  SnapshotSource,
  SnapshotWindow
} from "../core";
import {
  boundedNumber,
  connectorConnection,
  futureInstantFromEpochSeconds,
  futureInstantFromRfc3339,
  plausibleResetHorizon,
  rawMeter,
  record,
  shortExpiry
} from "./shared";

export const claudeLabels = {
  credentialOrigin: "official-local-tool",
  dataInterfaceStatus: "native-statusline-payload",
  automationRisk: "low",
  verification: "UNVERIFIED"
} as const satisfies ConnectorLabels;

export const claudeInput = {
  kind: "statusline_payload",
  path: null,
  readMode: "read_only"
} as const;

const FIVE_HOURS = 18_000;
const SEVEN_DAYS = 604_800;

/**
 * The longest a window this reader was never told the length of may run.
 *
 * A bucket whose key spells out no cadence still needs SOME plausibility bound,
 * or a corrupt reset becomes a countdown to the year 2038. A month is the
 * longest subscription window any provider in this product uses, so a reset
 * beyond it is a corrupt field rather than a long wait.
 */
export const CLAUDE_UNKNOWN_WINDOW_SECONDS = 2_678_400;

/**
 * The buckets whose names this build knows, and how long each one runs.
 *
 * Being on this list buys one thing: a fixed meter code that never moves, so a
 * surface can style the weekly Opus bar and keep styling it. It is NOT what
 * makes a bucket readable. Everything else in the table is read too, under a
 * code derived from its own key, because the failure this parser is fixing was
 * a frozen two entry table silently dropping every bucket Anthropic added
 * after it was written.
 */
const KNOWN_WINDOWS: Readonly<
  Record<string, { readonly meter: string; readonly durationSeconds: number }>
> = {
  five_hour: { meter: "FIVE_HOUR", durationSeconds: FIVE_HOURS },
  seven_day: { meter: "SEVEN_DAY", durationSeconds: SEVEN_DAYS },
  seven_day_opus: { meter: "SEVEN_DAY_OPUS", durationSeconds: SEVEN_DAYS },
  seven_day_sonnet: { meter: "SEVEN_DAY_SONNET", durationSeconds: SEVEN_DAYS },
  seven_day_oauth_apps: {
    meter: "SEVEN_DAY_OAUTH_APPS",
    durationSeconds: SEVEN_DAYS
  }
};

/** Keys that carry something other than one window, so never read as one. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "model_scoped",
  "limits",
  "extra_usage"
]);

/** The prefix every model scoped weekly bucket's code is built on. */
export const CLAUDE_MODEL_WEEKLY_PREFIX = "SEVEN_DAY_";

/** Longest source string this reader will turn into a meter code. */
export const MAX_METER_CODE_SOURCE_CHARS = 64;

/**
 * A meter code built from text the provider chose, or null.
 *
 * The one place provider supplied text is allowed anywhere near a field a human
 * reads, and it is allowed only after being reduced to upper snake case with
 * every other character removed and the result held against a strict pattern.
 * A display name is a sentence the provider controls; a meter code is a token
 * this product controls, and this function is the border between them.
 */
function meterCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_METER_CODE_SOURCE_CHARS) return null;
  /* Printable ASCII only. A right to left override or a zero width space in a
     model name has no business reaching a label. */
  if (!/^[\x20-\x7E]+$/u.test(value)) return null;
  const code = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return /^[A-Z][A-Z0-9_]{0,47}$/u.test(code) ? code : null;
}

/**
 * The share of a window consumed, however this document happens to state it.
 *
 * The statusline says `used_percentage`. The usage document behind the same
 * credential says `utilization`. They mean the same thing, and a reader that
 * knows only one of them reports nothing at all against the other, which is
 * finding F-201 in one sentence.
 *
 * Every name is tried until one of them is usable, rather than stopping at the
 * first one PRESENT. A key that exists and holds null is not an answer, and a
 * reader that treats it as one throws away the answer sitting beside it, which
 * is the same failure in a smaller box.
 */
function statedPercent(input: Record<string, unknown>): number | null {
  for (const field of ["used_percentage", "utilization", "percent"] as const) {
    const value = boundedNumber(input[field]);
    if (value !== null) return value;
  }
  return null;
}

/**
 * A reset instant, in either encoding these two documents use.
 *
 * The statusline writes Unix epoch SECONDS. The usage document writes an ISO
 * timestamp. Nothing is repaired in either branch: a number that is really
 * milliseconds and a string that is really a date in the past both fail, and
 * the window that stated them is dropped on its own.
 */
/**
 * An epoch written as digits in quotes, and long enough to be one.
 *
 * Nine digits is 1973 and thirteen is a millisecond stamp of today; outside
 * that range a bare number is not an epoch at all, it is a year, an identifier,
 * or a truncation, and it belongs in the date branch or nowhere.
 */
const QUOTED_EPOCH = /^\d{9,13}$/u;

/** Digit count above which a quoted epoch is milliseconds rather than seconds. */
const EPOCH_MILLISECOND_DIGITS = 13;

function resetInstant(
  value: unknown,
  now: string,
  maxAheadSeconds: number
): string | null {
  if (typeof value === "number") {
    return futureInstantFromEpochSeconds(value, now, maxAheadSeconds);
  }
  if (typeof value !== "string") return null;
  /*
   * A quoted epoch is read as an epoch BEFORE it is offered to the date
   * parser, and the order is the whole point: Date.parse is willing to read
   * "1767243600" as a year, so a reset five hours away reaches the wrong
   * branch and becomes an instant thirty thousand years out or nothing at all.
   * A JSON writer that quotes its numbers is not drift; the instant it names
   * is unambiguous once the unit is settled, and the unit settles on length.
   */
  const trimmed = value.trim();
  if (QUOTED_EPOCH.test(trimmed)) {
    const digits = Number.parseInt(trimmed, 10);
    const seconds = trimmed.length >= EPOCH_MILLISECOND_DIGITS
      ? digits / 1_000
      : digits;
    return futureInstantFromEpochSeconds(seconds, now, maxAheadSeconds);
  }
  return futureInstantFromRfc3339(value, now, maxAheadSeconds);
}

/**
 * How long an unrecognised bucket runs, when its own key says so.
 *
 * Anthropic names these buckets after their cadence, so `seven_day_haiku` is a
 * week whether or not this build has heard of it. That is worth reading,
 * because the alternative is the loosest plausibility bound for a window whose
 * length the key states outright. A key that spells out no cadence gets null
 * and an honestly unknown window rather than an invented five hours.
 */
function durationForKey(key: string): number | null {
  if (key.startsWith("seven_day")) return SEVEN_DAYS;
  if (key.startsWith("five_hour")) return FIVE_HOURS;
  return null;
}

function windowFor(durationSeconds: number | null): SnapshotWindow {
  return durationSeconds === null
    ? { kind: "unknown" }
    : { kind: "rolling", durationSeconds };
}

interface MeterInput {
  readonly meter: string;
  readonly percent: number;
  readonly durationSeconds: number | null;
  readonly resetAt: string | null;
  readonly amounts?: SnapshotAmounts;
}

function buildMeter(
  input: MeterInput,
  now: string,
  expiresAt: string,
  source: SnapshotSource
): RawMeter {
  return rawMeter({
    provider: "CLAUDE",
    meter: input.meter,
    value: input.percent,
    window: windowFor(input.durationSeconds),
    resetAt: input.resetAt,
    source,
    precision: "exact",
    observedAt: now,
    expiresAt,
    labels: claudeLabels,
    ...(input.amounts === undefined ? {} : { amounts: input.amounts })
  });
}

/**
 * One bucket, or null.
 *
 * The reset has to belong to the window that named it. A five hour window
 * resetting years from now is a corrupt field, not a long wait, and it is
 * dropped on its own so the other buckets still report.
 */
function parseWindow(
  value: unknown,
  now: string,
  meter: string,
  durationSeconds: number | null
): MeterInput | null {
  const input = record(value);
  if (input === null) return null;
  const percent = statedPercent(input);
  const resetAt = resetInstant(
    input["resets_at"],
    now,
    plausibleResetHorizon(durationSeconds ?? CLAUDE_UNKNOWN_WINDOW_SECONDS)
  );
  if (percent === null || resetAt === null) return null;
  return { meter, percent, durationSeconds, resetAt };
}

/**
 * Every bucket in a window table, keyed generically.
 *
 * Known keys keep their fixed codes. Anything else that is an object carrying
 * both a percentage and a reset becomes a meter under a code derived from its
 * own key, so a bucket Anthropic ships next month appears in this product the
 * day it appears in the payload rather than the day someone edits a table here.
 * Everything else in the table is ignored in silence, because a statusline
 * payload legitimately carries session identifiers and workspace paths beside
 * its meters and none of those are readings.
 *
 * The order is this build's, never the document's. Meter order used to follow
 * JSON key order, which no provider promises and which a proxy, a
 * re-serialiser or a client version bump changes for free, so the same account
 * could produce two different meter lists on two consecutive reads.
 */
function orderedWindowKeys(table: Record<string, unknown>): string[] {
  const remaining = new Set(
    Object.keys(table).filter((key) => !RESERVED_KEYS.has(key))
  );
  const ordered: string[] = [];
  /* The buckets this build knows lead, shortest window first, which is the
     order a person reads them in and the order every surface ranks them in. */
  for (const key of Object.keys(KNOWN_WINDOWS)) {
    if (!remaining.delete(key)) continue;
    ordered.push(key);
  }
  return [...ordered, ...[...remaining].sort()];
}

function parseWindowTable(
  table: Record<string, unknown>,
  now: string,
  seen: Set<string>
): MeterInput[] {
  const found: MeterInput[] = [];
  for (const key of orderedWindowKeys(table)) {
    const value = table[key];
    const known = KNOWN_WINDOWS[key];
    const meter = known?.meter ?? meterCode(key);
    if (meter === null || seen.has(meter)) continue;
    const parsed = parseWindow(
      value,
      now,
      meter,
      known?.durationSeconds ?? durationForKey(key)
    );
    if (parsed === null) continue;
    seen.add(meter);
    found.push(parsed);
  }
  return found;
}

/**
 * The model scoped weekly buckets the statusline adds beside the root table.
 *
 * Each entry names a model in words a human reads, so the code is built from
 * that name and prefixed with the cadence it belongs to: a Fable 5 entry is
 * SEVEN_DAY_FABLE_5. Deduplicated against whatever the root table already
 * reported, because Opus arrives twice on a payload that carries both
 * `seven_day_opus` and a model scoped Opus entry, and two bars for one pool is
 * the same lie as no bar at all.
 */
function parseModelScoped(
  value: unknown,
  now: string,
  seen: Set<string>
): MeterInput[] {
  if (!Array.isArray(value)) return [];
  const found: MeterInput[] = [];
  for (const entry of value) {
    const scoped = record(entry);
    if (scoped === null) continue;
    const name = meterCode(scoped["display_name"]);
    if (name === null) continue;
    const meter = CLAUDE_MODEL_WEEKLY_PREFIX + name;
    if (seen.has(meter)) continue;
    const parsed = parseWindow(scoped, now, meter, SEVEN_DAYS);
    if (parsed === null) continue;
    seen.add(meter);
    found.push(parsed);
  }
  return found;
}

/**
 * The `limits[]` list the usage document carries, which the statusline does not.
 *
 * Only `weekly_scoped` is read. Another kind names a cadence this build cannot
 * work out and a scope it cannot name, and guessing either would produce a bar
 * labelled with the wrong week, so an unrecognised kind is dropped alone and
 * the recognised ones beside it still report.
 */
function parseScopedLimits(
  value: unknown,
  now: string,
  seen: Set<string>
): MeterInput[] {
  if (!Array.isArray(value)) return [];
  const found: MeterInput[] = [];
  for (const entry of value) {
    const limit = record(entry);
    if (limit === null || limit["kind"] !== "weekly_scoped") continue;
    const scope = record(limit["scope"]);
    const model = record(scope?.["model"]);
    const name = meterCode(model?.["display_name"]);
    if (name === null) continue;
    const meter = CLAUDE_MODEL_WEEKLY_PREFIX + name;
    if (seen.has(meter)) continue;
    const parsed = parseWindow(limit, now, meter, SEVEN_DAYS);
    if (parsed === null) continue;
    seen.add(meter);
    found.push(parsed);
  }
  return found;
}

/** Money as the usage document states it, under any of the names it uses. */
function amountField(
  input: Record<string, unknown>,
  names: readonly string[]
): number | null {
  for (const name of names) {
    const value = input[name];
    if (value === undefined) continue;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  }
  return null;
}

/**
 * The extra usage pool, as a percentage with the money that produced it.
 *
 * Extra usage is spend beyond the plan, so it is the one Claude bucket stated
 * in dollars rather than in a share of a window. The percentage is derived from
 * the pair, and the pair travels with it so a surface can print "$12.47 of $20"
 * beside the bar instead of a bare percentage nobody can act on. A pool with no
 * ceiling states no percentage and produces no meter: an unbounded spend has no
 * denominator, and inventing one would be the worst kind of wrong answer.
 *
 * The amounts are handed on exactly as they were read. The core normalizer is
 * the only thing that decides whether they are believable, and it drops all
 * three together or keeps all three together, which leaves the percentage
 * standing either way.
 */
function parseExtraUsage(value: unknown, now: string): MeterInput | null {
  const input = record(value);
  if (input === null) return null;
  const used = amountField(input, ["used_amount", "used_credits", "used"]);
  const limit = amountField(
    input,
    ["limit_amount", "limit_credits", "monthly_limit", "limit", "cap"]
  );
  const stated = statedPercent(input);
  /*
   * Spend past the ceiling is capped, not dropped. The pool somebody has
   * overspent is the pool they most need to see, and refusing it made the one
   * bucket that was over its limit the one bucket that vanished. A percentage
   * cannot exceed a hundred, so a hundred is what it reads, and the money that
   * produced it travels on untouched for the normalizer to judge: it refuses a
   * used figure larger than its own limit and drops all three money fields,
   * which leaves the capped percentage standing on its own.
   */
  const derived =
    used === null || limit === null || limit <= 0
      ? null
      : Math.min(100, (used / limit) * 100);
  const percent = stated ?? derived;
  if (percent === null || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    return null;
  }
  const currency = input["currency"];
  const usable =
    used !== null &&
    limit !== null &&
    (currency === undefined ||
      (typeof currency === "string" && currency.toUpperCase() === "USD"));
  return {
    meter: "EXTRA_USAGE",
    percent,
    durationSeconds: null,
    resetAt: resetInstant(
      input["resets_at"],
      now,
      plausibleResetHorizon(CLAUDE_UNKNOWN_WINDOW_SECONDS)
    ),
    ...(usable
      ? {
          amounts: {
            usedAmount: used,
            limitAmount: limit,
            currency: "USD"
          } as SnapshotAmounts
        }
      : {})
  };
}

/**
 * Whether a document with no `rate_limits` is a usage document at all.
 *
 * A free account's statusline payload has no rate limits either, and it must
 * stay the honest unknown rather than being scanned for anything that looks
 * like a number. So the usage branch is entered only for a document that
 * announces itself: a scoped limits list, an extra usage pool, a model scoped
 * list, or at least one window whose key this build already knows.
 */
function looksLikeUsageDocument(root: Record<string, unknown>): boolean {
  if (Array.isArray(root["limits"])) return true;
  if (Array.isArray(root["model_scoped"])) return true;
  if (record(root["extra_usage"]) !== null) return true;
  return Object.keys(KNOWN_WINDOWS).some((key) => record(root[key]) !== null);
}

/**
 * Parse a Claude usage document, in either shape the same credential produces.
 *
 * SHAPE ONE, the statusline payload, from
 * https://code.claude.com/docs/en/statusline and observed on Claude Code
 * 2.1.261 on 2026-09-04:
 *
 * ```json
 * {
 *   "rate_limits": {
 *     "five_hour":            { "used_percentage": 23.5, "resets_at": 1738425600 },
 *     "seven_day":            { "used_percentage": 41.2, "resets_at": 1738857600 },
 *     "seven_day_oauth_apps": { "used_percentage": 3.1,  "resets_at": 1738857600 },
 *     "seven_day_opus":       { "used_percentage": 61.0, "resets_at": 1738857600 },
 *     "seven_day_sonnet":     { "used_percentage": 12.4, "resets_at": 1738857600 },
 *     "model_scoped": [
 *       { "display_name": "Fable 5", "utilization": 12, "resets_at": "2026-09-11T00:00:00Z" }
 *     ]
 *   }
 * }
 * ```
 *
 * SHAPE TWO, the `api/oauth/usage` document, which is what `openlimiter ingest`
 * is handed. Its windows sit at the root, state `utilization` and an ISO reset,
 * and it carries two things the statusline does not: an `extra_usage` pool
 * stated in money, and a `limits` list of model scoped weekly buckets:
 *
 * ```json
 * {
 *   "five_hour":   { "utilization": 90, "resets_at": "2026-09-04T17:00:00Z" },
 *   "seven_day":   { "utilization": 18, "resets_at": "2026-09-09T00:00:00Z" },
 *   "extra_usage": { "used_amount": 12.47, "limit_amount": 20, "currency": "USD" },
 *   "limits": [
 *     {
 *       "kind": "weekly_scoped",
 *       "percent": 61,
 *       "resets_at": "2026-09-09T00:00:00Z",
 *       "scope": { "model": { "display_name": "Opus" } }
 *     }
 *   ]
 * }
 * ```
 *
 * Refusing the second shape was finding F-201: a real document, from a real
 * account, over a healthy connection, answered null because this parser knew
 * only `used_percentage` and only epoch seconds.
 *
 * Three absences the documentation states, and none of them is an error:
 *
 * 1. `rate_limits` appears only for Claude.ai subscribers on Pro or Max, and
 *    only after the first API response in the session. A payload without it and
 *    without any usage document field is an ordinary payload from a free
 *    account or a session that has not called the API yet.
 * 2. Each bucket may be independently absent, so one present bucket is one
 *    meter and is a complete answer.
 * 3. No bucket present is the honest unknown, not zero.
 *
 * A bucket that fails validation is dropped and the rest still count, because
 * one corrupt reset is not a reason to forget the whole session.
 */
export function parseClaudePayload(payload: unknown, now: string): RawMeter[] | null {
  const root = record(payload);
  if (root === null) return null;
  const rateLimits = record(root["rate_limits"]);
  const statusline = rateLimits !== null;
  if (!statusline && !looksLikeUsageDocument(root)) return null;
  const table = rateLimits ?? root;
  const expiresAt = shortExpiry(now);
  if (expiresAt === null) return null;
  /*
   * One identity set across all four sources, which is what makes the dedupe
   * mean something: the root table claims its codes first, so a model scoped
   * entry naming a model the root already reported is the same pool twice and
   * is skipped rather than drawn twice.
   */
  const seen = new Set<string>();
  const inputs: MeterInput[] = [
    ...parseWindowTable(table, now, seen),
    ...parseModelScoped(table["model_scoped"], now, seen),
    ...parseScopedLimits(table["limits"], now, seen)
  ];
  const extra = parseExtraUsage(table["extra_usage"], now);
  if (extra !== null && !seen.has(extra.meter)) {
    seen.add(extra.meter);
    inputs.push(extra);
  }
  if (inputs.length === 0) return null;
  /*
   * The statusline is the payload Claude Code hands us directly. The usage
   * document is a private route read with the same credential, and calling it
   * a native payload would overstate what it is, so the two carry different
   * sources and the honesty labels above stay identical for both.
   */
  const source: SnapshotSource = statusline ? "native_payload" : "internal_payload";
  return inputs.map((input) => buildMeter(input, now, expiresAt, source));
}

/** The local application that owns this credential. */
export const CLAUDE_TOOL: ConnectionTool = "Claude Code";

export const claudeConnector: ConnectorContract = {
  id: "claude",
  encoding: "json",
  displayName: "Claude",
  labels: claudeLabels,
  detect(environment) {
    return environment["CLAUDE_CODE_STATUSLINE"] === "1";
  },
  async read(context): Promise<ConnectorResult> {
    const meters = parseClaudePayload(context.payload, context.now);
    const connection = connectorConnection(
      meters !== null,
      context.payload,
      CLAUDE_TOOL
    );
    return meters === null
      ? { ok: false, reason: "unknown", connection }
      : { ok: true, meters, connection };
  }
};
