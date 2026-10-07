/**
 * Who refreshes the cache, and how a terminal gets fresh bars with no daemon.
 *
 * Two questions live here, and they are different questions.
 *
 * Provider ownership is enforced by the shared machine lease in cache.ts.
 * Legacy desktop writer markers also reserve providers inside the freshness
 * interval, so a 2.0 CLI cooperates with a 1.3 desktop without leases.
 *
 * The second is freshness without a background service. A status line render
 * reads the cache and nothing else, and when the cache is older than a minute
 * it starts a detached refresh under a lock and returns immediately. The render
 * never waits for the network; the next render shows what the refresh found.
 */
import { randomUUID } from "node:crypto";
import { lstat, open, readFile, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import {
  prepareStateDirectory,
  readJsonFileSafely,
  resolveStateDirectory,
  writeFileAtomically
} from "../cache.js";
import { canonicalJson } from "../normalizer.js";
import type { Snapshot, SnapshotWriter } from "../types.js";
import { DESKTOP_OWNERSHIP_SECONDS } from "./cadence.js";

/**
 * How old the cache may be before a render starts a refresh behind itself.
 *
 * A minute, which is the number Lucas's own status line has used for months. It
 * is short enough that a person who opens a terminal sees current bars and long
 * enough that a status line redrawing on every keystroke starts nothing.
 */
export const CACHE_REFRESH_STALE_SECONDS = 60;

/** The lock one detached refresh holds, beside the cache lock and separate. */
export const REFRESH_LOCK_NAME = "openlimiter-refresh.lock";

/**
 * How often a running refresh says it is still alive.
 *
 * The lock's modification time is the signal, so the heartbeat only touches the
 * file and never rewrites it: the token inside has to stay byte for byte the
 * same, because that token is what proves ownership at every write below.
 */
export const REFRESH_LOCK_HEARTBEAT_MILLISECONDS = 10_000;

/**
 * How long a silent lock is honoured before it is treated as abandoned.
 *
 * Six missed heartbeats. The bound used to be a flat two minutes measured from
 * when the lock was TAKEN, which quietly assumed a whole round fits in two
 * minutes; seven providers, two of them two hop, each with a fifteen second
 * budget, does not fit, so a legitimate refresh could be declared dead and
 * raced by the next status line render. Measuring from the last heartbeat
 * instead means the bound is about liveness rather than about duration, and a
 * round may take as long as it takes.
 */
export const REFRESH_LOCK_STALE_MILLISECONDS = 60_000;

const REFRESH_LOCK_RECLAIM_BACKOFF_MILLISECONDS = 10;

async function backoff(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** The newest observation in a set of rows, in epoch milliseconds, or null. */
export function newestObservedMilliseconds(
  snapshots: readonly Snapshot[]
): number | null {
  let newest: number | null = null;
  for (const snapshot of snapshots) {
    const observed = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observed)) continue;
    if (newest === null || observed > newest) newest = observed;
  }
  return newest;
}

/**
 * How old the freshest row is, in seconds.
 *
 * An empty cache has no age, which the caller reads as "refresh": there is
 * nothing to be stale, and nothing to show either.
 */
export function cacheAgeSeconds(
  snapshots: readonly Snapshot[],
  now: string
): number | null {
  const current = Date.parse(now);
  const newest = newestObservedMilliseconds(snapshots);
  if (!Number.isFinite(current) || newest === null) return null;
  return (current - newest) / 1_000;
}

/**
 * Whether a writer has kept this cache fresh inside the ownership window.
 *
 * Absent markers answer false, which is the backward compatible reading: a
 * cache written before this field existed says nothing about who wrote it, and
 * a reader that assumed a desktop was running would stop refreshing on a
 * machine that has none.
 */
export function writerHoldsCache(
  snapshots: readonly Snapshot[],
  writer: SnapshotWriter,
  now: string,
  withinSeconds = DESKTOP_OWNERSHIP_SECONDS
): boolean {
  const current = Date.parse(now);
  if (!Number.isFinite(current)) return false;
  return snapshots.some((snapshot) => {
    if (snapshot.writer !== writer) return false;
    const observed = Date.parse(snapshot.observedAt);
    if (!Number.isFinite(observed)) return false;
    /* A row stamped in the future is a clock disagreement, not a fresh write,
       and treating it as ownership would silence this machine indefinitely. */
    if (observed > current) return false;
    return current - observed <= withinSeconds * 1_000;
  });
}

/** Whether a running desktop is already keeping this cache fresh. */
export function desktopHoldsCache(
  snapshots: readonly Snapshot[],
  now: string,
  withinSeconds = DESKTOP_OWNERSHIP_SECONDS
): boolean {
  return writerHoldsCache(snapshots, "desktop", now, withinSeconds);
}

/** Stamp rows with the process that is about to write them. */
export function withWriter(
  snapshots: readonly Snapshot[],
  writer: SnapshotWriter
): Snapshot[] {
  return snapshots.map((snapshot) => ({ ...snapshot, writer }));
}

export type RefreshDecision =
  | { refresh: true }
  | { refresh: false; reason: "fresh" | "desktop_running" };

/**
 * Whether this render should start a refresh behind itself.
 *
 * Three inputs and no side effects, so the whole policy is one testable
 * function rather than a condition spread across two commands.
 */
export function shouldStartRefresh(
  snapshots: readonly Snapshot[],
  now: string,
  staleSeconds = CACHE_REFRESH_STALE_SECONDS
): RefreshDecision {
  const providers = [...new Set(snapshots.map((row) => row.provider))];
  if (providers.length === 0) return { refresh: true };
  const decisions = providers.map((provider) => {
    const rows = snapshots.filter((row) => row.provider === provider);
    if (desktopHoldsCache(rows, now)) return "desktop_running";
    const age = cacheAgeSeconds(rows, now);
    return age !== null && age >= 0 && age <= staleSeconds ? "fresh" : "due";
  });
  if (decisions.includes("due")) return { refresh: true };
  if (decisions.every((decision) => decision === "desktop_running")) {
    return { refresh: false, reason: "desktop_running" };
  }
  return { refresh: false, reason: "fresh" };
}

/* ------------------------------------------------------------------ lock */

/**
 * Whether a refresh is running right now.
 *
 * A lock file older than the stale bound is not a running refresh, it is a
 * process that died, and it is reported as free so the next render can take
 * over. Nothing is deleted here: reclaiming belongs to the acquisition below,
 * which does it under the same create attempt that would have failed.
 */
export async function refreshLockHeld(
  directory = resolveStateDirectory(),
  nowMilliseconds = Date.now(),
  name = REFRESH_LOCK_NAME
): Promise<boolean> {
  try {
    const observed = await lstat(path.join(directory, name));
    if (!Number.isFinite(observed.mtimeMs)) return true;
    return nowMilliseconds - observed.mtimeMs < REFRESH_LOCK_STALE_MILLISECONDS;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    /* A lock we cannot even inspect is treated as held. Refusing to refresh is
       recoverable; two refreshes racing on one credential is not. */
    return true;
  }
}

export interface RefreshLockHolder {
  /** Give the lock up. Safe to call twice, and never removes somebody else's. */
  readonly release: () => Promise<void>;
  /**
   * Whether this holder still owns the lock.
   *
   * Checked before every write a round makes, because a reclaim is always
   * possible in principle and a round that lost its lock must not keep writing
   * over the round that took it.
   */
  readonly stillOwned: () => Promise<boolean>;
}

export type RefreshLockResult =
  | ({ ok: true } & RefreshLockHolder)
  | { ok: false; reason: "held" | "unavailable" };

/**
 * Take the refresh lock, or say why not.
 *
 * Exclusive creation is the whole mechanism: the operating system decides the
 * winner, so two terminals starting a refresh in the same millisecond produce
 * exactly one round of requests. The token inside the file is checked before
 * the release, so a process that lost its lock to the stale reclaim cannot
 * delete the lock its successor is holding.
 */
export async function acquireRefreshLock(
  directory = resolveStateDirectory(),
  nowMilliseconds = Date.now(),
  name = REFRESH_LOCK_NAME
): Promise<RefreshLockResult> {
  try {
    await prepareStateDirectory(directory);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const target = path.join(directory, name);
  const token = JSON.stringify({ at: nowMilliseconds, id: randomUUID(), pid: process.pid });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close().catch(() => undefined);
      }
      const owns = async (): Promise<boolean> => {
        try {
          return (await readFile(target, "utf8")) === token;
        } catch {
          return false;
        }
      };
      /*
       * The heartbeat is unreferenced, so it can never hold the process open
       * past the work it was watching, and it stops touching the file the
       * moment this holder stops owning it.
       */
      const beat = setInterval(() => {
        void (async () => {
          if (!(await owns())) return;
          const stamp = new Date();
          await utimes(target, stamp, stamp).catch(() => undefined);
        })();
      }, REFRESH_LOCK_HEARTBEAT_MILLISECONDS);
      beat.unref();
      return {
        ok: true,
        stillOwned: owns,
        release: async () => {
          clearInterval(beat);
          if (!(await owns())) return;
          await unlink(target).catch(() => undefined);
        }
      };
    } catch (error) {
      const code = errorCode(error);
      if (code !== "EEXIST") return { ok: false, reason: "unavailable" };
      if (attempt > 0) return { ok: false, reason: "held" };
      if (await refreshLockHeld(directory, nowMilliseconds, name)) {
        return { ok: false, reason: "held" };
      }
      /* A live holder can touch the file between the stale check and reclaim.
         Recheck after a short backoff both before and after unlinking, so a
         utimes race cannot make this process remove a lock that became live. */
      await backoff(REFRESH_LOCK_RECLAIM_BACKOFF_MILLISECONDS);
      if (await refreshLockHeld(directory, nowMilliseconds, name)) {
        return { ok: false, reason: "held" };
      }
      await unlink(target).catch(() => undefined);
      await backoff(REFRESH_LOCK_RECLAIM_BACKOFF_MILLISECONDS);
      if (await refreshLockHeld(directory, nowMilliseconds, name)) {
        return { ok: false, reason: "held" };
      }
    }
  }
  return { ok: false, reason: "held" };
}

/* ------------------------------------------------------------ detachment */

/** The file that remembers a refresh this machine could not start. */
export const REFRESH_SPAWN_FAILURE_NAME = "openlimiter-refresh-spawn.json";

/**
 * Remember that a background refresh could not be started.
 *
 * A detached spawn fails asynchronously: the executable is missing, or the
 * platform refuses, and the error arrives after the status line has already
 * drawn and returned. There is nobody left to tell at that point, so the fact
 * is written down instead and doctor reads it back. Best effort throughout,
 * because a machine that cannot start a refresh may well not be able to write
 * this either, and neither failure may break a render.
 */
export async function recordRefreshSpawnFailure(
  directory: string,
  now: string
): Promise<void> {
  await writeFileAtomically(
    path.join(directory, REFRESH_SPAWN_FAILURE_NAME),
    canonicalJson({ at: now, version: 1 })
  ).catch(() => undefined);
}

/** When the last background refresh failed to start, if one did. */
export async function readRefreshSpawnFailure(
  directory = resolveStateDirectory()
): Promise<string | null> {
  const document = await readJsonFileSafely(
    path.join(directory, REFRESH_SPAWN_FAILURE_NAME),
    4_096
  );
  if (!document.ok) return null;
  const value = document.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const at = (value as Record<string, unknown>)["at"];
  return typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null;
}

/** Forget it, which a refresh that actually ran is the proof of. */
export async function clearRefreshSpawnFailure(
  directory = resolveStateDirectory()
): Promise<void> {
  await unlink(path.join(directory, REFRESH_SPAWN_FAILURE_NAME)).catch(
    () => undefined
  );
}

export interface DetachedSpawn {
  (
    executable: string,
    argumentsList: readonly string[],
    options: {
      readonly cwd?: string;
      /**
       * Called when the child fails to start, which happens after this
       * function has already returned. The spawner must swallow the error
       * itself and call this, never let it reach the process as unhandled.
       */
      readonly onError?: () => void;
    }
  ): number;
}

export interface SpawnRefreshOptions {
  readonly snapshots: readonly Snapshot[];
  readonly now: string;
  readonly stateDirectory?: string;
  readonly nodeExecutable: string;
  readonly openLimiterScript: string;
  readonly spawn: DetachedSpawn;
  readonly staleSeconds?: number;
  readonly nowMilliseconds?: () => number;
  readonly processAlive?: (pid: number) => boolean;
  readonly killProcess?: (pid: number) => void;
}

export type SpawnRefreshResult =
  | { spawned: true }
  | {
      spawned: false;
      reason: "fresh" | "desktop_running" | "already_running" | "no_script" | "failed";
    };

/** Children created behind status line renders, and no other process. */
export const REFRESH_CHILD_REGISTRY_NAME = "openlimiter-refresh-children.json";
export const REFRESH_CHILD_STALE_MILLISECONDS = 120_000;
const REFRESH_CHILD_REGISTRY_LOCK_NAME = "openlimiter-refresh-children.lock";
const MAX_REFRESH_CHILDREN = 32;

interface RefreshChild {
  readonly pid: number;
  readonly spawnedAt: number;
}

function systemProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function readRefreshChildren(directory: string): Promise<RefreshChild[] | null> {
  const document = await readJsonFileSafely(
    path.join(directory, REFRESH_CHILD_REGISTRY_NAME),
    16_384
  );
  if (!document.ok) return document.reason === "missing" ? [] : null;
  if (typeof document.value !== "object" || document.value === null || Array.isArray(document.value)) return null;
  const value = document.value as Record<string, unknown>;
  if (value["version"] !== 1 || !Array.isArray(value["children"]) || value["children"].length > MAX_REFRESH_CHILDREN) return null;
  const children: RefreshChild[] = [];
  for (const child of value["children"]) {
    if (typeof child !== "object" || child === null || Array.isArray(child)) return null;
    const pid = (child as Record<string, unknown>)["pid"];
    const spawnedAt = (child as Record<string, unknown>)["spawnedAt"];
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || !Number.isSafeInteger(spawnedAt) || Number(spawnedAt) < 0) return null;
    children.push({ pid: Number(pid), spawnedAt: Number(spawnedAt) });
  }
  return children;
}

async function writeRefreshChildren(directory: string, children: readonly RefreshChild[]): Promise<void> {
  const target = path.join(directory, REFRESH_CHILD_REGISTRY_NAME);
  if (children.length === 0) {
    await unlink(target).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
    return;
  }
  await writeFileAtomically(target, canonicalJson({ children, version: 1 }));
}

async function refreshLockOwnedByPid(
  directory: string,
  pid: number,
  nowMilliseconds: number
): Promise<boolean> {
  const lock = await readJsonFileSafely(path.join(directory, REFRESH_LOCK_NAME), 4_096);
  if (!lock.ok) return lock.reason === "missing" ? false : true;
  if (typeof lock.value !== "object" || lock.value === null || Array.isArray(lock.value)) return true;
  if ((lock.value as Record<string, unknown>)["pid"] !== pid) return false;
  return refreshLockHeld(directory, nowMilliseconds);
}

async function reconcileRefreshChildren(
  directory: string,
  children: readonly RefreshChild[],
  nowMilliseconds: number,
  processAlive: (pid: number) => boolean,
  killProcess: (pid: number) => void
): Promise<{ children: RefreshChild[]; changed: boolean }> {
  const kept: RefreshChild[] = [];
  let changed = false;
  for (const child of children) {
    let alive = true;
    try {
      alive = processAlive(child.pid);
    } catch {
      alive = true;
    }
    if (!alive) {
      changed = true;
      continue;
    }
    if (nowMilliseconds - child.spawnedAt < REFRESH_CHILD_STALE_MILLISECONDS) {
      kept.push(child);
      continue;
    }
    if (await refreshLockOwnedByPid(directory, child.pid, nowMilliseconds)) {
      kept.push(child);
      continue;
    }
    try {
      killProcess(child.pid);
      changed = true;
    } catch {
      kept.push(child);
    }
  }
  return { children: kept, changed };
}

async function removeRegisteredRefreshChild(directory: string, pid: number): Promise<void> {
  const decisionLock = await acquireRefreshLock(
    directory,
    Date.now(),
    REFRESH_CHILD_REGISTRY_LOCK_NAME
  );
  if (!decisionLock.ok) return;
  try {
    const children = await readRefreshChildren(directory);
    if (children === null) return;
    const remaining = children.filter((child) => child.pid !== pid);
    if (remaining.length !== children.length) await writeRefreshChildren(directory, remaining);
  } finally {
    await decisionLock.release();
  }
}

/**
 * Start a refresh behind the caller, and never wait for it.
 *
 * Everything expensive happens in the child. This function creates one lock
 * file and hands the operating system a detached process, so the render that
 * called it returns in the time a file create takes. A failure to spawn is
 * reported and never thrown: a status line that cannot start a refresh still
 * has to draw the bars it already has.
 */
export async function spawnDetachedRefresh(
  options: SpawnRefreshOptions
): Promise<SpawnRefreshResult> {
  const directory = options.stateDirectory ?? resolveStateDirectory();
  const nowMilliseconds = (options.nowMilliseconds ?? Date.now)();
  const processAlive = options.processAlive ?? systemProcessAlive;
  const killProcess = options.killProcess ?? ((pid: number) => process.kill(pid));
  const decisionLock = await acquireRefreshLock(
    directory,
    nowMilliseconds,
    REFRESH_CHILD_REGISTRY_LOCK_NAME
  );
  if (!decisionLock.ok) {
    return { spawned: false, reason: decisionLock.reason === "held" ? "already_running" : "failed" };
  }
  try {
    const registered = await readRefreshChildren(directory);
    if (registered === null) return { spawned: false, reason: "failed" };
    const reconciled = await reconcileRefreshChildren(
      directory,
      registered,
      nowMilliseconds,
      processAlive,
      killProcess
    );
    if (reconciled.changed) await writeRefreshChildren(directory, reconciled.children);
    if (reconciled.children.some((child) => nowMilliseconds - child.spawnedAt < REFRESH_CHILD_STALE_MILLISECONDS)) {
      return { spawned: false, reason: "already_running" };
    }
    const decision = shouldStartRefresh(
      options.snapshots,
      options.now,
      options.staleSeconds ?? CACHE_REFRESH_STALE_SECONDS
    );
    if (!decision.refresh) return { spawned: false, reason: decision.reason };
    if (options.openLimiterScript === "") return { spawned: false, reason: "no_script" };
    /* The child takes the refresh lock. The short registry lock only makes
       the decision and the child record one transaction across status lines. */
    if (await refreshLockHeld(directory, nowMilliseconds)) {
      return { spawned: false, reason: "already_running" };
    }
    let childPid: number | undefined;
    const pid = options.spawn(
      options.nodeExecutable,
      [options.openLimiterScript, "refresh", "--detached"],
      {
        cwd: directory,
        onError: () => {
          void recordRefreshSpawnFailure(directory, options.now);
          if (childPid !== undefined) void removeRegisteredRefreshChild(directory, childPid);
        }
      }
    );
    childPid = pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Detached refresh has no process id");
    try {
      await writeRefreshChildren(directory, [...reconciled.children, { pid, spawnedAt: nowMilliseconds }]);
    } catch (error) {
      try { killProcess(pid); } catch { /* The child may already be gone. */ }
      throw error;
    }
    return { spawned: true };
  } catch {
    await recordRefreshSpawnFailure(directory, options.now);
    return { spawned: false, reason: "failed" };
  } finally {
    await decisionLock.release();
  }
}
