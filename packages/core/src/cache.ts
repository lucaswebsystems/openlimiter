import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalJson, normalizeMeter, normalizeMeters } from "./normalizer.js";
import type { RawMeter, Snapshot } from "./types.js";

export const CACHE_FILE_NAME = "openlimiter-cache.json";
export const CACHE_LOCK_NAME = "openlimiter.lock";

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

async function rejectSymlink(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("State path is a symbolic link");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function prepareStateDirectory(directory: string): Promise<void> {
  await rejectSymlink(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await rejectSymlink(directory);
  if (process.platform !== "win32") await chmod(directory, 0o700);
}

export type CacheReadResult =
  | { ok: true; snapshots: Snapshot[] }
  | { ok: false; reason: "missing" | "corrupt" | "unsafe" };

export async function readSnapshotCache(
  directory = resolveStateDirectory()
): Promise<CacheReadResult> {
  try {
    await rejectSymlink(directory);
    const file = path.join(directory, CACHE_FILE_NAME);
    await rejectSymlink(file);
    await access(file, constants.R_OK);
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("snapshots" in parsed)) {
      return { ok: false, reason: "corrupt" };
    }
    const rawSnapshots = (parsed as { snapshots?: unknown }).snapshots;
    if (!Array.isArray(rawSnapshots)) return { ok: false, reason: "corrupt" };
    const snapshots = normalizeMeters(rawSnapshots as RawMeter[]);
    if (snapshots.length !== rawSnapshots.length) {
      return { ok: false, reason: "corrupt" };
    }
    return { ok: true, snapshots };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "missing" };
    }
    if (error instanceof SyntaxError) return { ok: false, reason: "corrupt" };
    return { ok: false, reason: "unsafe" };
  }
}

export async function writeSnapshotCache(
  snapshots: readonly Snapshot[],
  directory = resolveStateDirectory()
): Promise<void> {
  if (
    snapshots.some(
      (snapshot) => normalizeMeter(snapshot as unknown as RawMeter) === null
    )
  ) throw new Error("Snapshot bounds rejected");
  await prepareStateDirectory(directory);
  const file = path.join(directory, CACHE_FILE_NAME);
  const lockPath = path.join(directory, CACHE_LOCK_NAME);
  await rejectSymlink(file);
  await rejectSymlink(lockPath);
  const lock = await open(lockPath, "wx", 0o600);
  const tempPath = path.join(
    directory,
    CACHE_FILE_NAME + "." + process.pid + "." + randomUUID() + ".tmp"
  );
  try {
    await writeFile(
      tempPath,
      canonicalJson({ snapshots, version: 1 }),
      { mode: 0o600, flag: "wx" }
    );
    if (process.platform !== "win32") await chmod(tempPath, 0o600);
    await rename(tempPath, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
  }
}
