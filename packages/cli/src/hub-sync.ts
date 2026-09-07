/**
 * Building, sending and resuming one sync upload.
 *
 * The envelope shape is the version 2 contract the hub reads, the same one
 * `packages/core/fixtures/sync-envelope-v2.json` shows and the desktop's own
 * Rust implementation (`apps/desktop/src-tauri/src/account.rs`) already
 * speaks. That file is read only reference here: this module is its own
 * implementation of the same cursor rules, in this package's own vocabulary,
 * because the CLI has no keyring and no long lived process to carry a
 * resumable upload in memory between runs. The cursor lives on disk instead,
 * exactly like the config and the session do.
 *
 * Three rules carry the whole contract. The sequence is a compare and swap
 * against the hub's own cursor: `previous_sequence` is what this device
 * believes the hub holds, and `sequence` is one past it. An upload whose
 * reply never arrived is retried as the SAME upload, same event id and same
 * bytes, because the hub deduplicates on the event id and a retry carrying
 * different bytes under it would be refused rather than deduplicated. And a
 * conflict that names the hub's own current sequence is adopted once and
 * retried, never fought.
 */
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";
import {
  canonicalJson,
  freshness,
  readJsonFileSafely,
  resolveStateDirectory,
  writeFileAtomically,
  type Snapshot
} from "@openlimiter/core";
import { parseHubJson, syncSnapshotsRequest, type HubTransport } from "./hub.js";

export const SYNC_CURSOR_FILE_NAME = "openlimiter-sync-cursor.json";

/** The contract version this build speaks, and nothing else. */
export const SYNC_SCHEMA_VERSION = 2;

/**
 * What this build calls itself on the wire.
 *
 * A constant, not a read of `package.json`: this module ships inside a
 * published package, and a runtime file read is one more thing that can fail
 * inside a command a status line depends on. See `acquire/identity.ts` in the
 * core package for the same choice, made for the same reason.
 */
export const SYNC_CLIENT_VERSION = "1.3.1";

/** Most rows one envelope may carry, usage and spend counted together. */
export const SYNC_MAX_ROWS = 128;

/** How long an unresolved upload may still be retried as itself. */
export const SYNC_RESUME_WINDOW_HOURS = 23;

export interface UsageSample {
  readonly account_id: string;
  readonly provider: string;
  readonly meter: string;
  readonly window_id: string;
  readonly usage_percent: number;
  readonly reset_at: string | null;
  readonly observed_at: string;
  readonly stale: boolean;
}

export interface ForecastInput {
  readonly first_observed_at: string;
  readonly last_observed_at: string;
  readonly sample_count: number;
  readonly burn_usd_per_day: number;
}

export interface ApiSpendSample {
  readonly source_id: string;
  readonly account_id: string;
  readonly provider: string;
  readonly key_label: string;
  readonly month: string;
  readonly spend_usd: number;
  readonly budget_usd: number | null;
  readonly source_period: readonly [string, string];
  readonly currency_source: string;
  readonly raw_unit_scale: number;
  readonly forecast_date: string | null;
  readonly forecast_input: ForecastInput | null;
  readonly period_complete: boolean;
}

export interface SyncEnvelope {
  readonly event_id: string;
  readonly device_id: string;
  readonly previous_sequence: number;
  readonly sequence: number;
  readonly observed_at: string;
  readonly client_version: string;
  readonly schema_version: number;
  readonly usage_samples: readonly UsageSample[];
  readonly api_spend_samples: readonly ApiSpendSample[];
}

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** The meter a budget reading uses, PERCENT unit and all: never a usage window. */
const EXCLUDED_USAGE_METER = "API_BUDGET_PERCENT";

/**
 * A row's account id, exactly as the desktop's own cache reader decides it.
 *
 * See `usage_samples_from_cache` in account.rs: absent is "default", the
 * ordinary single account case, but present and not shaped like an account id
 * is not quietly corrected to "default" either, because merging a malformed
 * id into the shared default bucket is its own wrong reading. Null here means
 * the row this id belongs to is dropped, not defaulted.
 */
function accountIdOf(snapshot: Snapshot): string | null {
  if (snapshot.accountId === undefined) return "default";
  return ACCOUNT_ID_PATTERN.test(snapshot.accountId) ? snapshot.accountId : null;
}

/**
 * Every usage row this device would upload, from the cache it already writes
 * for the terminal and the tray.
 *
 * Only `PERCENT` rows are usage: a credit or token count is not a usage
 * fraction and does not belong beside one. `API_BUDGET_PERCENT` is excluded
 * too, porting the same rule `usage_samples_from_cache` in account.rs reads
 * its own cache by: it is a budget reading at PERCENT unit, not a usage
 * window, and sending it is exactly what gets a whole envelope rejected
 * rather than the one row dropped, since the hub does not recognise it as
 * usage at all. The Rust reader excludes the Moonshot provider by name too,
 * as a second, belt and suspenders check; nothing here reproduces that one,
 * because it cannot fire on this side of the boundary. Moonshot's own budget
 * reading already carries provider `KIMI` in this build's own vocabulary
 * (`PROVIDER_CODES` in types.ts has no `MOONSHOT` at all, and
 * `normalizeMeter` refuses the whole reading for any provider string outside
 * that set before a `Snapshot` is ever built), so the meter check above is
 * this side's whole answer, not half of one. A row that fails a bound,
 * including an unreadable account id, is dropped rather than repaired,
 * matching the same rule the desktop reads its own cache by.
 */
export function usageSamplesFromSnapshots(
  snapshots: readonly Snapshot[],
  now: string
): UsageSample[] {
  const rows: UsageSample[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.unit !== "PERCENT") continue;
    if (snapshot.meter === EXCLUDED_USAGE_METER) continue;
    if (!Number.isFinite(snapshot.value) || snapshot.value < 0 || snapshot.value > 100) continue;
    const accountId = accountIdOf(snapshot);
    if (accountId === null) continue;
    rows.push({
      account_id: accountId,
      provider: snapshot.provider,
      meter: snapshot.meter,
      window_id: snapshot.meter,
      usage_percent: snapshot.value,
      reset_at: snapshot.resetAt,
      observed_at: snapshot.observedAt,
      stale: freshness(snapshot.observedAt, snapshot.expiresAt, now) !== "fresh"
    });
  }
  return rows.slice(0, SYNC_MAX_ROWS);
}

/** A deterministic, opaque row identifier, stable across resends. */
function stableSourceId(seed: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  return [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)]
    .join("-");
}

function monthStartDate(observedAt: string): string {
  const parsed = new Date(observedAt);
  if (Number.isNaN(parsed.getTime())) return observedAt.slice(0, 10);
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

/**
 * Every spend row the cache has enough to build.
 *
 * This build tracks a point in time reading, not a month to date total with a
 * forecast: those live in the desktop's dedicated spend engine, which this
 * package does not have. So every row this function builds states its period
 * honestly as "the start of this month through the moment of this upload"
 * and never claims a forecast or a completed period it did not compute.
 * `usedAmount`, `limitAmount` and `currency` travel together or not at all
 * (see `Snapshot` in the core package), which is what this reads as "the
 * cache has one".
 */
/** The providers the hub accepts an API spend sample for (mirrors API_PROVIDERS in the server contract); every other provider's spend stays local, otherwise one row would void the whole envelope. */
export const SYNC_API_SPEND_PROVIDERS: ReadonlySet<string> = new Set(["OPENAI", "ANTHROPIC", "XAI", "OPENROUTER"]);

export function apiSpendSamplesFromSnapshots(
  snapshots: readonly Snapshot[],
  envelopeObservedAt: string
): ApiSpendSample[] {
  const rows: ApiSpendSample[] = [];
  for (const snapshot of snapshots) {
    if (!SYNC_API_SPEND_PROVIDERS.has(snapshot.provider)) continue;
    if (
      snapshot.usedAmount === undefined ||
      snapshot.limitAmount === undefined ||
      snapshot.currency === undefined
    ) {
      continue;
    }
    if (!Number.isFinite(snapshot.usedAmount) || snapshot.usedAmount < 0) continue;
    if (!Number.isFinite(snapshot.limitAmount) || snapshot.limitAmount < 0) continue;
    const accountId = accountIdOf(snapshot);
    if (accountId === null) continue;
    rows.push({
      source_id: stableSourceId(snapshot.provider + ":" + accountId),
      account_id: accountId,
      provider: snapshot.provider,
      key_label: snapshot.accountLabel ?? accountId,
      month: monthStartDate(snapshot.observedAt),
      spend_usd: snapshot.usedAmount,
      budget_usd: snapshot.limitAmount,
      source_period: [monthStartDate(snapshot.observedAt) + "T00:00:00.000Z", envelopeObservedAt],
      currency_source: "PROVIDER_USD",
      raw_unit_scale: 1,
      forecast_date: null,
      forecast_input: null,
      period_complete: false
    });
  }
  return rows.slice(0, SYNC_MAX_ROWS);
}

export interface EnvelopeIdentity {
  readonly deviceId: string;
  readonly eventId: string;
  readonly previousSequence: number;
  readonly observedAt: string;
}

/**
 * One envelope from one set of readings.
 *
 * A reading observed after the envelope itself, which a clock stepping
 * backwards between the cache write and this call would produce, is pulled
 * back to the envelope's own timestamp rather than dropped. See
 * `build_envelope` in `account.rs` for the same rule.
 */
export function buildSyncEnvelope(
  identity: EnvelopeIdentity,
  usageSamples: readonly UsageSample[],
  apiSpendSamples: readonly ApiSpendSample[]
): SyncEnvelope {
  const ceiling = Date.parse(identity.observedAt);
  const usage = usageSamples.map((row) => {
    const observed = Date.parse(row.observed_at);
    const later = !Number.isFinite(observed) || (Number.isFinite(ceiling) && observed > ceiling);
    return later ? { ...row, observed_at: identity.observedAt } : row;
  });
  return {
    event_id: identity.eventId,
    device_id: identity.deviceId,
    previous_sequence: identity.previousSequence,
    sequence: identity.previousSequence + 1,
    observed_at: identity.observedAt,
    client_version: SYNC_CLIENT_VERSION,
    schema_version: SYNC_SCHEMA_VERSION,
    usage_samples: usage,
    api_spend_samples: apiSpendSamples
  };
}

function envelopeDigest(envelope: SyncEnvelope): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}

interface SyncCursor {
  readonly version: 1;
  readonly deviceId: string;
  readonly sequence: number;
  readonly pendingEventId?: string;
  readonly pendingSequence?: number;
  readonly pendingObservedAt?: string;
  readonly pendingDigest?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCursor(value: unknown, deviceId: string): SyncCursor {
  const empty: SyncCursor = { version: 1, deviceId, sequence: 0 };
  if (!isRecord(value)) return empty;
  if (value["version"] !== 1 || value["deviceId"] !== deviceId) return empty;
  const sequence = value["sequence"];
  if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0) return empty;
  const pendingEventId = value["pendingEventId"];
  const pendingSequence = value["pendingSequence"];
  const pendingObservedAt = value["pendingObservedAt"];
  const pendingDigest = value["pendingDigest"];
  const pendingComplete =
    typeof pendingEventId === "string" &&
    typeof pendingSequence === "number" &&
    typeof pendingObservedAt === "string" &&
    typeof pendingDigest === "string";
  if (!pendingComplete) return { version: 1, deviceId, sequence };
  return {
    version: 1,
    deviceId,
    sequence,
    pendingEventId,
    pendingSequence,
    pendingObservedAt,
    pendingDigest
  };
}

async function loadCursor(directory: string, deviceId: string): Promise<SyncCursor> {
  const result = await readJsonFileSafely(path.join(directory, SYNC_CURSOR_FILE_NAME));
  return normalizeCursor(result.ok ? result.value : null, deviceId);
}

async function saveCursor(directory: string, cursor: SyncCursor): Promise<void> {
  await writeFileAtomically(path.join(directory, SYNC_CURSOR_FILE_NAME), canonicalJson(cursor));
}

function cursorAwaiting(cursor: SyncCursor, envelope: SyncEnvelope): SyncCursor {
  return {
    version: 1,
    deviceId: cursor.deviceId,
    sequence: cursor.sequence,
    pendingEventId: envelope.event_id,
    pendingSequence: envelope.sequence,
    pendingObservedAt: envelope.observed_at,
    pendingDigest: envelopeDigest(envelope)
  };
}

function cursorSettled(cursor: SyncCursor, sequence: number): SyncCursor {
  return { version: 1, deviceId: cursor.deviceId, sequence };
}

/**
 * The upload still in flight, when nothing about the readings has changed.
 *
 * See `resumable_upload` in `account.rs`: the same event id, the same
 * sequence and the same bytes are what the hub deduplicates on, so a retry
 * has to rebuild the identical envelope or mint a fresh event id instead of
 * reusing this one under different bytes.
 */
function resumableEnvelope(
  cursor: SyncCursor,
  usageSamples: readonly UsageSample[],
  apiSpendSamples: readonly ApiSpendSample[],
  now: string
): SyncEnvelope | null {
  if (
    cursor.pendingEventId === undefined ||
    cursor.pendingSequence === undefined ||
    cursor.pendingObservedAt === undefined ||
    cursor.pendingDigest === undefined
  ) {
    return null;
  }
  if (cursor.pendingSequence !== cursor.sequence + 1) return null;
  const observedAtMs = Date.parse(cursor.pendingObservedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) return null;
  if (nowMs - observedAtMs >= SYNC_RESUME_WINDOW_HOURS * 3_600_000) return null;
  const candidate = buildSyncEnvelope(
    {
      deviceId: cursor.deviceId,
      eventId: cursor.pendingEventId,
      previousSequence: cursor.sequence,
      observedAt: cursor.pendingObservedAt
    },
    usageSamples,
    apiSpendSamples
  );
  return envelopeDigest(candidate) === cursor.pendingDigest ? candidate : null;
}

type SyncReplyOutcome =
  | { readonly kind: "accepted"; readonly sequence: number; readonly tier: string | null }
  | { readonly kind: "reconcile"; readonly sequence: number }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" };

function classifySyncReply(
  status: number,
  body: Record<string, unknown>,
  sentSequence: number
): SyncReplyOutcome {
  if (status === 200 && body["accepted"] === true) {
    const sequence = typeof body["sequence"] === "number" ? body["sequence"] : sentSequence;
    const tier = typeof body["tier"] === "string" ? body["tier"] : null;
    return { kind: "accepted", sequence, tier };
  }
  if (status === 409) {
    const currentSequence = body["current_sequence"];
    return typeof currentSequence === "number"
      ? { kind: "reconcile", sequence: currentSequence }
      : { kind: "rejected" };
  }
  if (status >= 400 && status < 500) return { kind: "rejected" };
  return { kind: "unavailable" };
}

export interface RunSyncOptions {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly transport: HubTransport;
  readonly now: string;
  readonly token: string;
  readonly deviceId: string;
  readonly snapshots: readonly Snapshot[];
}

export type SyncResult =
  | { readonly kind: "nothing_to_sync" }
  | { readonly kind: "accepted"; readonly rows: number; readonly tier: string | null }
  | { readonly kind: "revoked" }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" };

/**
 * One upload, on the version 2 contract, with the same three way ending the
 * hub's cursor rule requires: accepted advances the cursor, a reply that
 * never arrived leaves the same upload pending for the next run, and a
 * conflict names the hub's own sequence and is retried once.
 */
export async function runSync(options: RunSyncOptions): Promise<SyncResult> {
  const usageSamples = usageSamplesFromSnapshots(options.snapshots, options.now);
  const room = Math.max(0, SYNC_MAX_ROWS - usageSamples.length);
  const apiSpendSamples = apiSpendSamplesFromSnapshots(options.snapshots, options.now).slice(0, room);
  if (usageSamples.length === 0 && apiSpendSamples.length === 0) {
    return { kind: "nothing_to_sync" };
  }
  let cursor = await loadCursor(options.directory, options.deviceId);
  let resumed = resumableEnvelope(cursor, usageSamples, apiSpendSamples, options.now);
  for (let round = 0; round < 2; round += 1) {
    const envelope = resumed ?? buildSyncEnvelope(
      {
        deviceId: options.deviceId,
        eventId: randomUUID(),
        previousSequence: cursor.sequence,
        observedAt: options.now
      },
      usageSamples,
      apiSpendSamples
    );
    resumed = null;
    cursor = cursorAwaiting(cursor, envelope);
    await saveCursor(options.directory, cursor);
    const request = syncSnapshotsRequest(options.environment, options.token, envelope);
    if (request === null) return { kind: "rejected" };
    let reply;
    try {
      reply = await options.transport(request);
    } catch {
      try {
        /* The first failure is a lost reply, not a refusal, so the exact
           same bytes go again under the same event id. */
        reply = await options.transport(request);
      } catch {
        return { kind: "unavailable" };
      }
    }
    if (reply.status === 401) return { kind: "revoked" };
    const outcome = classifySyncReply(reply.status, parseHubJson(reply.body) ?? {}, envelope.sequence);
    if (outcome.kind === "accepted") {
      cursor = cursorSettled(cursor, outcome.sequence);
      await saveCursor(options.directory, cursor);
      return { kind: "accepted", rows: usageSamples.length + apiSpendSamples.length, tier: outcome.tier };
    }
    if (outcome.kind === "reconcile") {
      cursor = cursorSettled(cursor, outcome.sequence);
      await saveCursor(options.directory, cursor);
      if (round === 0) continue;
      return { kind: "rejected" };
    }
    if (outcome.kind === "rejected") {
      cursor = cursorSettled(cursor, cursor.sequence);
      await saveCursor(options.directory, cursor);
      return { kind: "rejected" };
    }
    /* Unavailable: the cursor stays exactly as awaiting left it, so the next
       run resumes this same upload. */
    return { kind: "unavailable" };
  }
  return { kind: "unavailable" };
}

/** The state directory's default, exported so a caller need not repeat it. */
export function defaultSyncDirectory(): string {
  return resolveStateDirectory();
}
