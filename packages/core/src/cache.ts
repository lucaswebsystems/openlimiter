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
  visibleSnapshots,
  type CacheState,
  type CacheSuppression,
  type CollectionReport
} from "./collection.js";
import { MAX_CACHE_ENTRIES, mergeSnapshots } from "./merge.js";
import { canonicalJson, normalizeMeter, normalizeMeters } from "./normalizer.js";
import type { RawMeter, Snapshot } from "./types.js";

export const CACHE_FILE_NAME = "openlimiter-cache.json";
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

async function prepareStateDirectory(directory: string): Promise<void> {
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
  if (version !== undefined && version !== 1 && version !== CACHE_DOCUMENT_VERSION) {
    return { ok: false, reason: "corrupt" };
  }
  const validated = normalizeMeters(rawSnapshots as RawMeter[]);
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
  const read = readSuppressions(document.value["suppressions"]);
  if (!read.ok) return { ok: false, reason: "corrupt" };
  return {
    ok: true,
    state: {
      snapshots: normalizeMeters(rawSnapshots as RawMeter[]),
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
export const CACHE_DOCUMENT_VERSION = 2;

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
  directory = resolveStateDirectory()
): Promise<CacheMergeResult> {
  rejectOutOfBounds(incoming);
  return await withCacheLock(directory, async () => {
    const cached = await readCacheState(directory);
    const state: CacheState = cached.ok
      ? cached.state
      : { snapshots: [], suppressions: [] };
    const merged = mergeSnapshots(state.snapshots, incoming);
    if (canonicalJson(merged) === canonicalJson(state.snapshots)) {
      return { merged, written: false };
    }
    rejectOutOfBounds(merged);
    await replaceCache(directory, merged, state.suppressions);
    return { merged, written: true };
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
