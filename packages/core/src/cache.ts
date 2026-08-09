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
import { MAX_CACHE_ENTRIES, mergeSnapshots } from "./merge.js";
import { canonicalJson, normalizeMeter, normalizeMeters } from "./normalizer.js";
import type { RawMeter, Snapshot } from "./types.js";

export const CACHE_FILE_NAME = "openlimiter-cache.json";
export const CACHE_LOCK_NAME = "openlimiter.lock";

/** Largest JSON document this package will read into memory. */
export const MAX_JSON_FILE_BYTES = 1_048_576;

/** A lock older than this is treated as abandoned and reclaimed. */
export const LOCK_STALE_MILLISECONDS = 5_000;

const LOCK_ATTEMPT_LIMIT = 40;
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
  | { ok: true; snapshots: Snapshot[]; dropped: number }
  | { ok: false; reason: "missing" | "corrupt" | "unsafe" };

/**
 * Read the snapshot cache.
 *
 * A row that fails validation is dropped and counted. The surviving rows are
 * still returned, because one bad row is not a reason to forget every other
 * provider. No value is ever repaired or invented.
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
  const snapshots = normalizeMeters(rawSnapshots as RawMeter[]);
  return { ok: true, snapshots, dropped: rawSnapshots.length - snapshots.length };
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
  try {
    const parsed: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    const stamp = isRecord(parsed) ? parsed["at"] : undefined;
    if (typeof stamp === "number" && Number.isFinite(stamp) && stamp <= now) {
      heldSince = stamp;
    }
  } catch {
    heldSince = null;
  }
  if (heldSince === null) {
    try {
      heldSince = (await lstat(lockPath)).mtimeMs;
    } catch {
      return true;
    }
    if (!Number.isFinite(heldSince) || heldSince > now) heldSince = now;
  }
  if (now - heldSince < LOCK_STALE_MILLISECONDS) return false;
  await unlink(lockPath).catch(() => undefined);
  return true;
}

async function acquireLock(
  lockPath: string
): Promise<{ handle: FileHandle; token: string }> {
  const token = JSON.stringify({ at: Date.now(), pid: process.pid });
  for (let attempt = 0; attempt < LOCK_ATTEMPT_LIMIT; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(token, "utf8").catch(() => undefined);
      return { handle, token };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (!(await reclaimStaleLock(lockPath))) {
        await delay(backoffMilliseconds(attempt));
      }
    }
  }
  throw new Error("Cache lock is busy");
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
  await prepareStateDirectory(directory);
  const lockPath = path.join(directory, CACHE_LOCK_NAME);
  await rejectSymlink(lockPath);
  const { handle, token } = await acquireLock(lockPath);
  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await releaseLock(lockPath, token);
  }
}

async function replaceCache(
  directory: string,
  snapshots: readonly Snapshot[]
): Promise<void> {
  const file = path.join(directory, CACHE_FILE_NAME);
  await rejectSymlink(file);
  await writeFileAtomically(file, canonicalJson({ snapshots, version: 1 }));
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
    const cached = await readSnapshotCache(directory);
    const existing = cached.ok ? cached.snapshots : [];
    const merged = mergeSnapshots(existing, incoming);
    if (canonicalJson(merged) === canonicalJson(existing)) {
      return { merged, written: false };
    }
    rejectOutOfBounds(merged);
    await replaceCache(directory, merged);
    return { merged, written: true };
  });
}
