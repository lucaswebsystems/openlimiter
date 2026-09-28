import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
  type Stats
} from "node:fs";
import path from "node:path";
import {
  isActivityEvent, MAX_ACTIVITY_EVENT_AGE_MS, MAX_ACTIVITY_EVENT_BYTES,
  MAX_ACTIVITY_SPOOL_BYTES, readActivityEvent, type ActivityEvent
} from "./contract.js";

const EVENT_NAME = /^(\d{16})-([a-f0-9-]{36})\.json$/u;
const TEMP_NAME = /^\.[a-f0-9-]{36}\.tmp$/u;
const MAX_ENTRIES = 65_536;
/* A healthy writer holds the lock for milliseconds; a hook killed mid write
   (Ctrl+C in the agent) strands it, so recover well before the event age. */
const STALE_WRITER_LOCK_MS = 10_000;

export interface ActivitySpoolOptions {
  /** The existing OpenLimiter state root, never a value from a hook payload. */
  directory: string;
  now?: number;
  signal?: AbortSignal;
  /** Monotonic deadline for synchronous filesystem work; timers cannot interrupt it. */
  deadline?: number;
  /** Windows must establish and verify an inheritable owner ACL before writing. */
  protectWindowsDirectory?: (directory: string) => Promise<void>;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function checkpoint(options: ActivitySpoolOptions): void {
  options.signal?.throwIfAborted();
  if (options.deadline !== undefined && performance.now() >= options.deadline) throw new Error("activity: deadline");
}

/** Check every ancestor, including junctions, before any creation or read. */
function directories(target: string, create: boolean): boolean {
  if (!path.isAbsolute(target)) throw new Error("activity: absolute state root required");
  let current = path.parse(target).root;
  let created = false;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    if (segment === "." || segment === "..") throw new Error("activity: path escape");
    current = path.join(current, segment);
    let info: Stats;
    try { info = lstatSync(current); } catch (error) {
      if (!create || code(error) !== "ENOENT") throw error;
      try { mkdirSync(current, { mode: 0o700 }); if (current === target) created = true; } catch (error) {
        if (code(error) !== "EEXIST") throw error;
      }
      info = lstatSync(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("activity: unsafe directory");
  }
  return created;
}

function spoolPath(root: string): string {
  if (!path.isAbsolute(root) || root.split(/[\\/]/u).includes("..")) throw new Error("activity: path escape");
  return path.join(root, "activity");
}

function same(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function regular(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 &&
    (process.platform === "win32" ||
      (info.uid === process.getuid?.() && (info.mode & 0o077) === 0));
}

function readFile(file: string, info: Stats, now: number): ActivityEvent {
  if (!regular(info) || info.size > MAX_ACTIVITY_EVENT_BYTES) throw new Error("activity: unsafe file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!same(info, opened) || !regular(opened) || opened.size > MAX_ACTIVITY_EVENT_BYTES) throw new Error("activity: changed file");
    const bytes = Buffer.alloc(MAX_ACTIVITY_EVENT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_ACTIVITY_EVENT_BYTES) throw new Error("activity: oversized file");
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    const event = readActivityEvent(serialized, now, "desktop");
    if (event.source === "hook" && !isActivityEvent(event, now, "hook")) throw new Error("activity: invalid hook process");
    return event;
  } finally { closeSync(fd); }
}

export async function prepareActivitySpool(options: ActivitySpoolOptions): Promise<string> {
  checkpoint(options);
  const directory = spoolPath(options.directory);
  const created = directories(directory, true);
  const before = lstatSync(directory);
  if (process.platform === "win32") {
    const stamp = path.join(directory, ".acl-verified");
    let verified = false;
    try {
      const info = lstatSync(stamp);
      verified = regular(info) && info.size <= MAX_ACTIVITY_EVENT_BYTES &&
        (options.now ?? Date.now()) - info.mtimeMs <= MAX_ACTIVITY_EVENT_AGE_MS;
    } catch (error) { if (code(error) !== "ENOENT") throw error; }
    if (created || !verified) {
      if (!options.protectWindowsDirectory) throw new Error("activity: Windows ACL helper required");
      await options.protectWindowsDirectory(directory);
      checkpoint(options);
      directories(directory, false);
      if (!same(before, lstatSync(directory))) throw new Error("activity: changed directory");
      const temporary = path.join(directory, "." + randomUUID() + ".tmp");
      try {
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { writeFileSync(fd, ""); } finally { closeSync(fd); }
        // Replace only the stamp itself. Never traverse a planted directory or link.
        try {
          const info = lstatSync(stamp);
          if (info.isDirectory() && !info.isSymbolicLink()) rmdirSync(stamp);
          else if (!regular(info)) unlinkSync(stamp);
        } catch (error) { if (code(error) !== "ENOENT") throw error; }
        renameSync(temporary, stamp);
      } finally { try { unlinkSync(temporary); } catch { /* Published or failed stamp. */ } }
    }
  } else {
    if (before.uid !== process.getuid?.()) throw new Error("activity: wrong directory owner");
    chmodSync(directory, 0o700);
  }
  checkpoint(options);
  directories(directory, false);
  if (!same(before, lstatSync(directory))) throw new Error("activity: changed directory");
  return directory;
}

/** A global spool lock serializes size accounting and sequence allocation. */
export async function writeActivityEvent(event: ActivityEvent, options: ActivitySpoolOptions): Promise<ActivityEvent> {
  const now = options.now ?? Date.now();
  if (!isActivityEvent(event, now, event.source === "hook" ? "hook" : "desktop")) throw new Error("activity: invalid event");
  const directory = await prepareActivitySpool(options);
  const lock = path.join(directory, ".writer");
  const deadline = performance.now() + 40;
  while (true) {
    checkpoint(options);
    try { mkdirSync(lock, { mode: 0o700 }); break; } catch (error) {
      if (code(error) !== "EEXIST" || performance.now() >= deadline) throw error;
      const info = lstatSync(lock);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("activity: unsafe lock");
      // Only an empty abandoned lock can be recovered. Never recurse into it.
      if (now - info.mtimeMs > STALE_WRITER_LOCK_MS) { rmdirSync(lock); continue; }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  let temporary: string | undefined;
  try {
    directories(directory, false);
    let total = 0;
    let sequence = Math.max(event.sequence, now * 1_000);
    const entries = readdirSync(directory);
    if (entries.length > MAX_ENTRIES) throw new Error("activity: too many entries");
    for (const name of entries) {
      checkpoint(options);
      if (name === ".writer") continue;
      const file = path.join(directory, name);
      const info = lstatSync(file);
      if (!regular(info)) throw new Error("activity: unsafe spool entry");
      const match = EVENT_NAME.exec(name);
      const owned = match !== null || TEMP_NAME.test(name);
      if (owned && now - info.mtimeMs > MAX_ACTIVITY_EVENT_AGE_MS) { unlinkSync(file); continue; }
      if (info.size > MAX_ACTIVITY_EVENT_BYTES) throw new Error("activity: oversized spool entry");
      /* Names and times only: parsing every record here made each write O(n)
         reads and dropped hooks once a busy day filled the spool. A record
         whose observedAt is stale is refused by the reader and removed by
         the age cleanup above. */
      total += info.size;
      if (match !== null) sequence = Math.max(sequence, Number(match[1]) + 1);
    }
    const stored = { ...event, sequence };
    if (!isActivityEvent(stored, now, event.source === "hook" ? "hook" : "desktop")) throw new Error("activity: invalid sequence");
    const bytes = Buffer.from(JSON.stringify(stored));
    if (bytes.length > MAX_ACTIVITY_EVENT_BYTES || total + bytes.length > MAX_ACTIVITY_SPOOL_BYTES) throw new Error("activity: spool full");
    const id = randomUUID();
    temporary = path.join(directory, "." + id + ".tmp");
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    checkpoint(options);
    directories(directory, false);
    renameSync(temporary, path.join(directory, String(sequence).padStart(16, "0") + "-" + id + ".json"));
    temporary = undefined;
    return stored;
  } finally {
    if (temporary !== undefined) { try { unlinkSync(temporary); } catch { /* Failed writes never publish. */ } }
    rmdirSync(lock);
  }
}

/** Read only. Invalid, stale, partial and hostile records are counted and skipped. */
export function readActivitySpool(directory: string, now = Date.now()): { events: ActivityEvent[]; skipped: number } {
  const events: ActivityEvent[] = [];
  let skipped = 0;
  try {
    const spool = spoolPath(directory);
    directories(spool, false);
    const info = lstatSync(spool);
    if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new Error("activity: unsafe directory");
    const names = readdirSync(spool);
    let total = 0;
    for (const [index, name] of names.entries()) {
      if (name === ".acl-verified" && process.platform === "win32") {
        const stamp = lstatSync(path.join(spool, name));
        if (!regular(stamp) || stamp.size > MAX_ACTIVITY_EVENT_BYTES) skipped += 1;
        continue;
      }
      if (name === ".writer") {
        const lock = lstatSync(path.join(spool, name));
        if (!lock.isDirectory() || lock.isSymbolicLink()) skipped += 1;
        continue;
      }
      try {
        if (index >= MAX_ENTRIES || !EVENT_NAME.test(name)) throw new Error("activity: unexpected name");
        const file = path.join(spool, name);
        const info = lstatSync(file);
        total += info.size;
        if (total > MAX_ACTIVITY_SPOOL_BYTES) throw new Error("activity: read cap");
        events.push(readFile(file, info, now));
      } catch { skipped += 1; }
    }
  } catch (error) { if (code(error) !== "ENOENT") skipped += 1; }
  events.sort((left, right) => left.sequence - right.sequence || left.observedAt.localeCompare(right.observedAt) || left.eventId.localeCompare(right.eventId));
  return { events, skipped };
}
