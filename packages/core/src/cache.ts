import { freshnessPolicy, retainSnapshots } from "./data-rules.js";
export { freshnessPolicy } from "./data-rules.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  applyCollectionReport,
  readSuppressions,
  snapshotBelongsTo,
  visibleSnapshots,
  type CacheState,
  type CacheSuppression,
  type CollectionReport
} from "./collection.js";
import { MAX_CACHE_ENTRIES, mergeSnapshots, snapshotIdentity } from "./merge.js";
import { canonicalJson, normalizeMeter, normalizeMeters } from "./normalizer.js";
import type { ProviderCode, RawMeter, Snapshot } from "./types.js";

export const CACHE_FILE_NAME = "openlimiter-cache.json";
export const MAX_POLICY_TIMESTAMP = 253_402_300_799_999;

/** Pure policy shared with the desktop contract. All instants are UTC. */
export function retryPolicy(input: { attemptCount: number; retryAfter: string | null; now: string; jitterSeconds: number; layer: string }) {
  const now = Date.parse(input.now);
  const raw = input.retryAfter?.trim();
  const server = raw === undefined ? NaN : /^\d+$/u.test(raw)
    ? Math.min(MAX_POLICY_TIMESTAMP, now + Number(raw) * 1000)
    : /^[A-Za-z]{3}, /u.test(raw) ? Date.parse(raw) : NaN;
  const localDelaySeconds = Math.min(60 * 2 ** Math.min(input.attemptCount, 4), 900) + Math.max(0, input.jitterSeconds);
  const ceiling = now + (input.layer === "collector" ? 86400 : 604800) * 1000;
  const cappedServer = Math.min(server, ceiling);
  const serverDeadline = Number.isFinite(server) ? new Date(cappedServer).toISOString() : null;
  return {
    localDelaySeconds, serverDeadline,
    nextAllowedAt: new Date(Math.max(now + localDelaySeconds * 1000, Number.isFinite(server) ? cappedServer : 0)).toISOString(),
    blockedUntil: server > ceiling ? serverDeadline : null
  };
}

export function leasePolicy(input: { now: string; requester: string; owner: string | null; expiresAt: string | null; leaseSeconds: number }) {
  const acquired = input.owner === null || input.expiresAt === null || Date.parse(input.expiresAt) <= Date.parse(input.now);
  return {
    acquired, takeover: acquired && input.owner !== null && input.owner !== input.requester,
    owner: acquired ? input.requester : input.owner,
    expiresAt: acquired ? new Date(Date.parse(input.now) + input.leaseSeconds * 1000).toISOString() : input.expiresAt
  };
}

export function withPolicyFreshness(snapshot: Snapshot): Snapshot {
  if (!["native_payload", "documented_api", "internal_payload", "local_file"].includes(snapshot.source)) return snapshot;
  return { ...snapshot, expiresAt: freshnessPolicy({ ...snapshot, sourceClass: snapshot.source, now: snapshot.observedAt }).expiresAt };
}

export async function recordAcquisitionAvailability(provider: ProviderCode, availability: "expired_credentials" | "access_denied" | "quota_unavailable" | "rate_limited", now: string, retryAt: string | undefined, directory = resolveStateDirectory(), accountId?: string): Promise<void> {
  await withCacheLock(directory, async () => {
    const state = await readCacheState(directory);
    if (!state.ok && state.reason !== "missing") throw new Error("Unreadable snapshot cache");
    const rows = retainSnapshots(state.ok ? state.state.snapshots : [], Date.parse(now));
    const matches = (row: Snapshot) => row.provider === provider && row.accountId === accountId;
    const matching = rows.filter(matches);
    if (matching.some(row => row.observedAt > now)) return;
    const seed: Snapshot = {
      provider, ...(accountId ? { accountId } : {}), meter: "ACQUISITION", value: 0, unit: "PERCENT", kind: "runtime_info", window: { kind: "unknown" }, resetAt: null,
      source: "internal_payload", precision: "exact", observedAt: now, writer: "cli",
      expiresAt: freshnessPolicy({ sourceClass: "internal_payload", observedAt: now, now }).expiresAt,
      labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint", automationRisk: "high", verification: "UNVERIFIED" }
    };
    const snapshots = [...rows.filter((row) => !matches(row)), ...(matching.length ? matching : [seed]).map((row) => {
      const { retryAt: _oldRetry, ...rest } = row;
      return { ...rest, availability, ...(availability === "rate_limited" && retryAt ? { retryAt } : {}) };
    })];
    await replaceCache(directory, snapshots, state.ok ? state.state.suppressions : []);
  });
}

interface MachinePolicy {
  refusalRevision?: string | null;
  lastAccount?: string | null;
  owner: string | null;
  expiresAt: number;
  token: string;
  nextAllowedAt: number;
  attempts: number;
}

export interface MachineLease {
  readonly attempts: number;
  stillOwned(now?: number): Promise<boolean>;
  complete(nextAllowedAt: number, attempts: number, refusalRevision?: string): Promise<void>;
  release(): Promise<void>;
}

/** Provider scope deliberately also excludes aliases of the same account. */
export async function acquireMachineLease(provider: string, directory = resolveStateDirectory(), now = Date.now(), credentialRevision?: string): Promise<MachineLease | null> {
  const named = provider.toLowerCase().replaceAll("_", "-");
  const slug = named === "gemini-cli" || named === "antigravity" ? "code-assist" : named;
  if (!/^[a-z][a-z-]{0,31}$/u.test(slug)) throw new Error("Invalid provider");
  const file = path.join(directory, `acquisition-${slug}.json`);
  const read = async (): Promise<MachinePolicy> => {
    const result = await readJsonFileSafely(file);
    if (!result.ok) {
      if (result.reason !== "missing") throw new Error("Unreadable acquisition policy");
      return { owner: null, expiresAt: 0, token: "", nextAllowedAt: 0, attempts: 0 };
    }
    const value = result.value as MachinePolicy;
    if (!isRecord(value) || !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(value.nextAllowedAt) || !Number.isSafeInteger(value.attempts) || typeof value.token !== "string" || (value.owner !== null && value.owner !== "desktop" && value.owner !== "cli")) throw new Error("Invalid acquisition policy");
    return value;
  };
  const state = await withCacheLock(directory, async () => {
    const current = await read();
    const decision = leasePolicy({ now: new Date(now).toISOString(), requester: "cli", owner: current.owner, expiresAt: new Date(current.expiresAt).toISOString(), leaseSeconds: 60 });
    const changedRefusal = typeof current.refusalRevision === "string" && credentialRevision !== undefined && current.refusalRevision !== credentialRevision;
    if (!decision.acquired || (now < current.nextAllowedAt && !changedRefusal)) return null;
    const next = { ...current, lastAccount: null, owner: "cli", expiresAt: now + 60_000, token: randomUUID() };
    await writeFileAtomically(file, canonicalJson(next));
    return next;
  });
  if (state === null) return null;
  const mutate = async (action: (current: MachinePolicy) => void) => withCacheLock(directory, async () => {
    const current = await read();
    if (current.token !== state.token) throw new Error("Acquisition lease lost");
    action(current);
    await writeFileAtomically(file, canonicalJson(current));
  });
  const started = Date.now();
  const heartbeat = setInterval(() => {
    void mutate((current) => {
      const at = now + Date.now() - started;
      if (current.owner !== "cli" || at >= current.expiresAt) throw new Error("Acquisition lease expired");
      current.expiresAt = at + 60_000;
    }).catch(() => clearInterval(heartbeat));
  }, 20_000);
  heartbeat.unref();
  return {
    attempts: state.attempts,
    stillOwned: async (at = Date.now()) => { const current = await read(); return current.token === state.token && current.owner === "cli" && at < current.expiresAt; },
    complete: async (nextAllowedAt, attempts, refusalRevision) => mutate((current) => { current.nextAllowedAt = nextAllowedAt; current.attempts = attempts; current.refusalRevision = refusalRevision ?? null; }),
    release: async () => {
      clearInterval(heartbeat);
      await mutate((current) => { current.owner = null; current.expiresAt = 0; }).catch(() => undefined);
    }
  };
}
export const CACHE_LOCK_NAME = "openlimiter.lock";

/** Largest JSON document this package will read into memory. */
export const MAX_JSON_FILE_BYTES = 1_048_576;

/** A lock older than this is treated as abandoned and reclaimed. */
export const LOCK_STALE_MILLISECONDS = 5_000;

/** The longest pause between lock acquisition attempts. It is not a deadline. */
const LOCK_BACKOFF_CEILING_MILLISECONDS = 25;

export interface StateDirectoryOptions {
  platform?: NodeJS.Platform;
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
}

export function resolveStateDirectory(options: StateDirectoryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  if (platform === "win32") {
    const local = environment["LOCALAPPDATA"];
    return path.join(local === undefined || local === "" ? home : local, "openlimiter");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "openlimiter");
  }
  const xdg = environment["XDG_STATE_HOME"];
  return path.join(
    xdg === undefined || xdg === "" ? path.join(home, ".local", "state") : xdg,
    "openlimiter"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function rejectSymlink(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("State path is a symbolic link");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function prepareStateDirectory(directory: string): Promise<void> {
  await rejectSymlink(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectSymlink(directory);
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

export type JsonFileResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "missing" | "corrupt" | "unsafe" };

/*
 * O_NOFOLLOW makes the kernel refuse a final path component that is a symbolic
 * link. Windows does not define it, so the constant collapses to zero there and
 * the identity comparison below carries the check on its own.
 */
const openFlags = constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

/**
 * Read and parse a JSON document without a window between the safety check and
 * the read.
 *
 * The descriptor is opened first and every check runs against that descriptor,
 * so a path swapped after the open cannot redirect the bytes that come back.
 * The path is compared with the open object by device and inode, which rejects
 * a symbolic link, a junction, and a file replaced mid read.
 */
export async function readJsonFileSafely(
  file: string,
  maximumBytes = MAX_JSON_FILE_BYTES
): Promise<JsonFileResult> {
  let handle: FileHandle;
  try {
    handle = await open(file, openFlags);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unsafe" };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { ok: false, reason: "unsafe" };
    if (opened.size > maximumBytes) return { ok: false, reason: "corrupt" };
    const linked = await lstat(file);
    if (linked.isSymbolicLink()) return { ok: false, reason: "unsafe" };
    if (linked.dev !== opened.dev || linked.ino !== opened.ino) {
      return { ok: false, reason: "unsafe" };
    }
    const text = await handle.readFile("utf8");
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, reason: "corrupt" };
    }
  } catch {
    return { ok: false, reason: "unsafe" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export type CacheReadResult =
  | {
      ok: true;
      /** The rows a surface may use: suppressed identities are already gone. */
      snapshots: Snapshot[];
      /** Rows that failed validation and were dropped. */
      dropped: number;
      /** Rows dropped because a drift suppression covers them. */
      suppressed: number;
      /** The standing suppressions, for a writer that has to preserve them. */
      suppressions: CacheSuppression[];
    }
  | { ok: false; reason: "missing" | "corrupt" | "unsafe" };

/**
 * Read the snapshot cache.
 *
 * A row that fails validation is dropped and counted. The surviving rows are
 * still returned, because one bad row is not a reason to forget every other
 * provider. No value is ever repaired or invented.
 *
 * The rows that come back have already had drift suppressions applied, so
 * there is no way for a caller to obtain the raw list and forget to filter it.
 * That matters more than it looks: `buildAdvice` and every surface downstream
 * of it read through here, which is what makes a drifted provider go unknown
 * on the statusline, in the agent context and on the dashboard at the same
 * instant rather than only on a connection card.
 *
 * A suppression list that cannot be believed empties the whole document. See
 * `readSuppressions`: the failure direction has to be unknown, because the
 * alternative is showing a number the cache itself was trying to withdraw.
 */
export async function readSnapshotCache(
  directory = resolveStateDirectory()
): Promise<CacheReadResult> {
  try {
    await rejectSymlink(directory);
  } catch {
    return { ok: false, reason: "unsafe" };
  }
  const document = await readJsonFileSafely(path.join(directory, CACHE_FILE_NAME));
  if (!document.ok) return document;
  if (!isRecord(document.value)) return { ok: false, reason: "corrupt" };
  const rawSnapshots = document.value["snapshots"];
  if (!Array.isArray(rawSnapshots)) return { ok: false, reason: "corrupt" };
  if (rawSnapshots.length > MAX_CACHE_ENTRIES) return { ok: false, reason: "corrupt" };
  const version = document.value["version"];
  /* Absent is version 1, which predates the field. A version this build does
     not know is refused rather than read with today's meanings. */
  if (version !== undefined && version !== 1 && version !== 2 && version !== CACHE_DOCUMENT_VERSION) {
    return { ok: false, reason: "corrupt" };
  }
  const migrated = version === 2
    ? rawSnapshots.filter((row) => !(isRecord(row) && row["provider"] === "ANTIGRAVITY")) as RawMeter[]
    : rawSnapshots as RawMeter[];
  const validated = normalizeMeters(migrated);
  const dropped = rawSnapshots.length - validated.length;
  const read = readSuppressions(document.value["suppressions"]);
  if (!read.ok) {
    /* Unreadable suppressions make every identity in the document unknown.
       Nothing is repaired, and nothing is shown on the strength of a list we
       could not parse. */
    return { ok: true, snapshots: [], dropped, suppressed: validated.length, suppressions: [] };
  }
  const snapshots = visibleSnapshots({
    snapshots: validated,
    suppressions: read.suppressions
  });
  return {
    ok: true,
    snapshots,
    dropped,
    suppressed: validated.length - snapshots.length,
    suppressions: read.suppressions
  };
}

/**
 * The cache document as stored, suppressions included and unfiltered.
 *
 * `readSnapshotCache` above is what a surface uses, and it hides suppressed
 * rows. A writer needs the other thing: the rows exactly as they are on disk,
 * so a fold can remove them properly instead of merging around a filtered view
 * and quietly resurrecting what it could not see.
 */
export async function readCacheState(
  directory = resolveStateDirectory()
): Promise<{ ok: true; state: CacheState } | { ok: false; reason: "missing" | "corrupt" | "unsafe" }> {
  try {
    await rejectSymlink(directory);
  } catch {
    return { ok: false, reason: "unsafe" };
  }
  const document = await readJsonFileSafely(path.join(directory, CACHE_FILE_NAME));
  if (!document.ok) return document;
  if (!isRecord(document.value)) return { ok: false, reason: "corrupt" };
  const rawSnapshots = document.value["snapshots"];
  if (!Array.isArray(rawSnapshots)) return { ok: false, reason: "corrupt" };
  if (rawSnapshots.length > MAX_CACHE_ENTRIES) return { ok: false, reason: "corrupt" };
  const version = document.value["version"];
  if (version !== undefined && version !== 1 && version !== 2 && version !== CACHE_DOCUMENT_VERSION) {
    return { ok: false, reason: "corrupt" };
  }
  const read = readSuppressions(document.value["suppressions"]);
  if (!read.ok) return { ok: false, reason: "corrupt" };
  return {
    ok: true,
    state: {
      snapshots: normalizeMeters(version === 2
        ? rawSnapshots.filter((row) => !(isRecord(row) && row["provider"] === "ANTIGRAVITY")) as RawMeter[]
        : rawSnapshots as RawMeter[]),
      suppressions: read.suppressions
    }
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function backoffMilliseconds(attempt: number): number {
  const growth = Math.min(4 + attempt * 2, LOCK_BACKOFF_CEILING_MILLISECONDS);
  return growth + Math.floor(Math.random() * 5);
}

const RENAME_ATTEMPT_LIMIT = 12;
const transientRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Replace a file, retrying the transient failures Windows reports.
 *
 * Windows refuses to replace a destination that another process has open for a
 * moment, which a reader or a virus scanner can cause at any time. The failure
 * clears on its own, so a bounded retry is the difference between a durable
 * write and a lost one. Every other failure is raised immediately.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (
        attempt >= RENAME_ATTEMPT_LIMIT ||
        code === undefined ||
        !transientRenameCodes.has(code)
      ) throw error;
      await delay(backoffMilliseconds(attempt));
    }
  }
}

/**
 * Write a file so that a reader sees either the previous content or the new
 * content, never a partial write.
 *
 * The payload is flushed to stable storage before the rename, so a crash right
 * after the rename cannot leave an empty file behind.
 */
export async function writeFileAtomically(
  target: string,
  contents: string
): Promise<void> {
  const tempPath = target + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    const temporary = await open(tempPath, "wx", 0o600);
    try {
      await temporary.writeFile(contents, "utf8");
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    if (process.platform !== "win32") await chmod(tempPath, 0o600);
    await renameWithRetry(tempPath, target);
    if (process.platform !== "win32") await chmod(target, 0o600);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}

/**
 * Decide whether an existing lock has been abandoned and remove it if so.
 *
 * The owner stamp inside the lock is the primary signal. An empty or unreadable
 * lock falls back to the file modification time, which covers the short window
 * between creating the lock and writing the stamp into it.
 */
async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  const now = Date.now();
  let heldSince: number | null = null;
  let observedContents: string | null = null;
  try {
    observedContents = await readFile(lockPath, "utf8");
    const parsed: unknown = JSON.parse(observedContents);
    const stamp = isRecord(parsed) ? parsed["at"] : undefined;
    if (typeof stamp === "number" && Number.isFinite(stamp) && stamp <= now) {
      heldSince = stamp;
    }
  } catch {
    heldSince = null;
  }
  let observedDevice: number;
  let observedInode: number;
  let modificationTime: number;
  try {
    const observed = await lstat(lockPath);
    observedDevice = observed.dev;
    observedInode = observed.ino;
    modificationTime = observed.mtimeMs;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  if (heldSince === null) {
    heldSince = modificationTime;
    if (!Number.isFinite(heldSince) || heldSince > now) heldSince = now;
  }
  if (now - heldSince < LOCK_STALE_MILLISECONDS) return false;
  try {
    if (
      observedContents !== null &&
      (await readFile(lockPath, "utf8")) !== observedContents
    ) return false;
    const observed = await lstat(lockPath);
    if (observed.dev !== observedDevice || observed.ino !== observedInode) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
}

const transientLockCodes = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);

async function lockPathExists(lockPath: string): Promise<boolean> {
  try {
    await lstat(lockPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function acquireLock(
  lockPath: string
): Promise<{ handle: FileHandle; token: string }> {
  /* Contention has no deadline. A live owner releases the lock and an
     abandoned owner becomes stale, so neither case should discard this write. */
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const token = JSON.stringify({
        at: Date.now(),
        id: randomUUID(),
        pid: process.pid
      });
      try {
        await handle.writeFile(token, "utf8");
        return { handle, token };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      const code = errorCode(error);
      if (
        code === undefined ||
        !transientLockCodes.has(code) ||
        !(await lockPathExists(lockPath))
      ) throw error;
      if (!(await reclaimStaleLock(lockPath))) {
        await delay(backoffMilliseconds(attempt));
      }
    }
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) !== token) return;
  } catch {
    return;
  }
  await unlink(lockPath).catch(() => undefined);
}

function rejectOutOfBounds(snapshots: readonly Snapshot[]): void {
  if (snapshots.length > MAX_CACHE_ENTRIES) throw new Error("Snapshot bounds rejected");
  if (
    snapshots.some(
      (snapshot) => normalizeMeter(snapshot as unknown as RawMeter) === null
    )
  ) throw new Error("Snapshot bounds rejected");
}

/* Writers in this process take FIFO turns before competing for the filesystem
   lock. Other processes still use the same lock, while one busy provider can
   no longer make an earlier local waiter lose a bounded polling race. */
const processLockQueues = new Map<string, Promise<void>>();

/**
 * Run one cache mutation while holding the single cache lock.
 *
 * Readers never take this lock. They rely on the atomic replacement below, so
 * the lock exists only to keep two writers from interleaving.
 */
async function withCacheLock<Result>(
  directory: string,
  action: () => Promise<Result>
): Promise<Result> {
  const absoluteDirectory = path.resolve(directory);
  const queueKey = process.platform === "win32"
    ? absoluteDirectory.toLowerCase()
    : absoluteDirectory;
  const previousTurn = processLockQueues.get(queueKey);
  let finishTurn: () => void = () => undefined;
  const currentTurn = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });
  processLockQueues.set(queueKey, currentTurn);
  if (previousTurn !== undefined) await previousTurn;
  try {
    await prepareStateDirectory(absoluteDirectory);
    const lockPath = path.join(absoluteDirectory, CACHE_LOCK_NAME);
    await rejectSymlink(lockPath);
    const { handle, token } = await acquireLock(lockPath);
    try {
      return await action();
    } finally {
      await handle.close().catch(() => undefined);
      await releaseLock(lockPath, token);
    }
  } finally {
    finishTurn();
    if (processLockQueues.get(queueKey) === currentTurn) {
      processLockQueues.delete(queueKey);
    }
  }
}

/**
 * Document version of the snapshot cache.
 *
 * It stayed at 1 through `accountId` and `provenance`, because both were
 * optional fields an old reader could ignore without being wrong.
 *
 * Version 2 is the first change that fails that test. A `suppressions` array is
 * an instruction to DISTRUST rows that are still present in the document, so a
 * reader that ignores it does not miss a nicety, it shows a number the writer
 * was withdrawing. That is a misread rather than an omission, which is exactly
 * what the version number is for.
 *
 * A version 1 document is still read, and read correctly: it has no
 * suppressions, which is true of it.
 */
export const CACHE_DOCUMENT_VERSION = 3;

async function replaceCache(
  directory: string,
  snapshots: readonly Snapshot[],
  suppressions: readonly CacheSuppression[] = []
): Promise<void> {
  const file = path.join(directory, CACHE_FILE_NAME);
  await rejectSymlink(file);
  /* The suppressions key is written only when there is something to say, so a
     machine that has never drifted keeps writing the document it always did. */
  const document = suppressions.length === 0
    ? { snapshots, version: CACHE_DOCUMENT_VERSION }
    : { snapshots, suppressions, version: CACHE_DOCUMENT_VERSION };
  await writeFileAtomically(file, canonicalJson(document));
}

/**
 * Replace the snapshot cache.
 *
 * Every snapshot is revalidated before anything touches the disk, the payload
 * is flushed to stable storage before the rename, and the lock carries an owner
 * stamp so a writer that died cannot freeze the cache forever.
 */
export async function writeSnapshotCache(
  snapshots: readonly Snapshot[],
  directory = resolveStateDirectory()
): Promise<void> {
  rejectOutOfBounds(snapshots);
  await withCacheLock(directory, async () => {
    await replaceCache(directory, snapshots);
  });
}

export interface CacheMergeResult {
  merged: Snapshot[];
  written: boolean;
}

/**
 * Fold fresh snapshots into the cache under the lock.
 *
 * Reading, merging, and writing all happen inside one lock, so two writers that
 * observe different providers cannot silently drop each other's rows. An
 * unchanged result skips the write entirely, which keeps a statusline that
 * renders on every keystroke from churning the disk.
 */
export async function mergeSnapshotCache(
  incoming: readonly Snapshot[],
  directory = resolveStateDirectory(),
  now = Date.now()
): Promise<CacheMergeResult> {
  rejectOutOfBounds(incoming);
  return await withCacheLock(directory, async () => {
    const cached = await readCacheState(directory);
    const state: CacheState = cached.ok
      ? cached.state
      : { snapshots: [], suppressions: [] };
    const merged = retainSnapshots(mergeSnapshots(state.snapshots, incoming), now);
    if (canonicalJson(merged) === canonicalJson(state.snapshots)) {
      return { merged, written: false };
    }
    rejectOutOfBounds(merged);
    await replaceCache(directory, merged, state.suppressions);
    return { merged, written: true };
  });
}

/**
 * Fold rows this machine just acquired into the cache, without ever losing a
 * newer row somebody else wrote.
 *
 * The problem this exists for: two PROCESSES write this cache, the desktop tray
 * and this command line tool, and a lock held by one of them means nothing to
 * the other. A plain collection report replaces every row for its identity,
 * which is correct when the writer owns the provider and destructive when a
 * desktop wrote a fresher row for the same identity a moment ago.
 *
 * So the decision is made INSIDE the cache lock, which both processes do share,
 * and it is made per row: the newer `observedAt` wins, and on a tie the row
 * already in the cache wins. Ties go to the incumbent because the only way to
 * get one is two writers reading the same instant, and in that case the row
 * that is already visible should not flicker.
 *
 * When nothing was deferred this behaves exactly like a collection report, so a
 * provider that stops reporting a window still loses that row. When something
 * was deferred the write becomes a merge instead, because dropping the rows for
 * an identity we did not fully win would delete the very rows we deferred to.
 */
export async function mergeAcquiredSnapshots(
  report: Extract<CollectionReport, { ok: true }>,
  directory = resolveStateDirectory()
): Promise<{ written: boolean; taken: number; deferred: number }> {
  rejectOutOfBounds(report.snapshots);
  return await withCacheLock(directory, async () => {
    const cached = await readCacheState(directory);
    const before: CacheState = cached.ok
      ? { ...cached.state, snapshots: cached.state.snapshots.filter((row) => !(row.provider === report.provider && row.accountId === report.accountId && row.meter === "ACQUISITION" && row.availability !== undefined && row.observedAt <= report.observedAt)) }
      : { snapshots: [], suppressions: [] };
    const held = new Map(
      before.snapshots.map((snapshot) => [snapshotIdentity(snapshot), snapshot])
    );
    const taken: Snapshot[] = [];
    let deferred = 0;
    for (const incoming of report.snapshots) {
      const existing = held.get(snapshotIdentity(incoming));
      const existingAt = existing === undefined
        ? null
        : Date.parse(existing.observedAt);
      const incomingAt = Date.parse(incoming.observedAt);
      const loses = existing !== undefined &&
        Number.isFinite(existingAt) &&
        Number.isFinite(incomingAt) &&
        (existingAt as number) >= incomingAt;
      if (loses) {
        deferred += 1;
        continue;
      }
      taken.push(incoming);
    }
    /*
     * The authoritative replace drops every row for this identity before it
     * merges, which is right when this process owns them all and destructive
     * when it does not. A round that reports FEWER windows than last time would
     * otherwise delete another writer's row for a window it simply did not
     * report, which is how the desktop's five hour Codex row disappeared the
     * first time this was written. So a row belonging to this identity that
     * nobody in this round reported and that this tool did not write is enough
     * on its own to make the write a merge.
     */
    const incomingIdentities = new Set(
      report.snapshots.map((snapshot) => snapshotIdentity(snapshot))
    );
    const foreign = before.snapshots.filter(
      (snapshot) =>
        snapshotBelongsTo(snapshot, report.provider, report.accountId) &&
        snapshot.writer !== "cli" &&
        !incomingIdentities.has(snapshotIdentity(snapshot))
    ).length;
    if (deferred === 0 && foreign === 0) {
      const after = applyCollectionReport(before, report);
      if (canonicalJson(after) === canonicalJson(before)) {
        return { written: false, taken: taken.length, deferred };
      }
      rejectOutOfBounds(after.snapshots);
      await replaceCache(directory, after.snapshots, after.suppressions);
      return { written: true, taken: taken.length, deferred };
    }
    const merged = retainSnapshots(mergeSnapshots(before.snapshots, taken), Date.parse(report.observedAt));
    if (canonicalJson(merged) === canonicalJson(before.snapshots)) {
      return { written: false, taken: taken.length, deferred };
    }
    rejectOutOfBounds(merged);
    await replaceCache(directory, merged, before.suppressions);
    return { written: true, taken: taken.length, deferred };
  });
}

/**
 * Fold one collection report into the cache under the lock.
 *
 * The verb the desktop and the command line tool should both reach for, because
 * it is the only one that can record a drift. `mergeSnapshotCache` above says
 * "here are some rows"; this says "here is what a run of one provider actually
 * achieved", and only the second can express that a provider stopped making
 * sense. Reading, folding and writing all happen inside one lock, so a drift
 * and a concurrent refresh cannot interleave into a document where a
 * suppression exists and the row it suppresses has already been replaced.
 */
export async function applyCollectionReportToCache(
  report: CollectionReport,
  directory = resolveStateDirectory()
): Promise<{ state: CacheState; written: boolean }> {
  if (report.ok) rejectOutOfBounds(report.snapshots);
  return await withCacheLock(directory, async () => {
    const cached = await readCacheState(directory);
    const before: CacheState = cached.ok
      ? cached.state
      : { snapshots: [], suppressions: [] };
    const after = applyCollectionReport(before, report);
    if (canonicalJson(after) === canonicalJson(before)) {
      return { state: after, written: false };
    }
    rejectOutOfBounds(after.snapshots);
    await replaceCache(directory, after.snapshots, after.suppressions);
    return { state: after, written: true };
  });
}

/** Startup maintenance uses the same lock as all writers and never repairs unreadable state. */
export async function pruneSnapshotCache(directory = resolveStateDirectory(), now = Date.now()): Promise<number> {
  const existing = await readCacheState(directory);
  if (!existing.ok) return 0;
  return withCacheLock(directory, async () => {
    const cached = await readCacheState(directory);
    if (!cached.ok) return 0;
    const snapshots = retainSnapshots(cached.state.snapshots, now);
    const count = cached.state.snapshots.length - snapshots.length;
    if (count) await replaceCache(directory, snapshots, cached.state.suppressions);
    return count;
  });
}
