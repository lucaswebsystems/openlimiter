import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireRefreshLock, writeFileAtomically } from "@openlimiter/core";

interface Backup { version: 1; original: string | null; installed: string }
const backupPath = (file: string): string => `${file}.openlimiter-backup.json`;

export async function readOptional(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function backup(file: string): Promise<Backup | null> {
  const raw = await readOptional(backupPath(file));
  if (raw === null) return null;
  const value = JSON.parse(raw) as Backup;
  if (value.version !== 1 || !(value.original === null || typeof value.original === "string") || typeof value.installed !== "string") throw new Error("Invalid backup");
  return value;
}

/** Recover the first configuration, including across reinstalls and state moves. */
export async function originalConfiguration(file: string, current: string | null): Promise<string | null> {
  const saved = await backup(file);
  if (saved !== null && saved.installed !== current) throw new Error("Configuration changed");
  return saved === null ? current : saved.original;
}

async function withFileLock<Result>(file: string, action: () => Promise<Result>): Promise<Result> {
  const directory = path.dirname(file);
  const lockName = `.${path.basename(file)}.openlimiter.lock`;
  for (;;) {
    const lock = await acquireRefreshLock(directory, Date.now(), lockName);
    if (lock.ok) {
      try { return await action(); }
      finally { await lock.release(); }
    }
    if (lock.reason === "unavailable") throw new Error("Configuration lock unavailable");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function isOwned(file: string, current: string, marker: boolean): Promise<boolean> {
  const saved = await backup(file);
  return marker && saved !== null && saved.installed === current;
}

export async function writeOwned(file: string, original: string | null, installed: string): Promise<void> {
  await withFileLock(file, async () => {
    const current = await readOptional(file);
    if (current !== original) throw new Error("Configuration changed");
    const saved = await backup(file);
    if (saved !== null && saved.installed !== current) throw new Error("Configuration changed");
    if (current === installed) return;

    const next = { version: 1 as const, original: saved === null ? original : saved.original, installed } satisfies Backup;
    if (saved === null) {
      // Exclusive creation guarantees that a repeated install cannot replace the
      // original bytes. A write failure leaves the recoverable backup in place.
      await writeFile(backupPath(file), JSON.stringify(next), { flag: "wx", mode: 0o600 });
    } else {
      await writeFileAtomically(backupPath(file), JSON.stringify(next));
    }
    await writeFileAtomically(file, installed);
    if (await readFile(file, "utf8") !== installed) throw new Error("Configuration changed");
  });
}

export async function restoreOwned(file: string, current: string, marker: boolean): Promise<boolean> {
  return await withFileLock(file, async () => {
    const latest = await readOptional(file);
    if (latest !== current) return false;
    const saved = await backup(file);
    if (saved !== null && (!marker || saved.installed !== latest)) throw new Error("Configuration changed");
    if (!(marker && saved !== null)) return false;
    if (saved.original === null) await rm(file);
    else await writeFileAtomically(file, saved.original);
    if (await readOptional(file) !== saved.original) throw new Error("Configuration changed");
    await rm(backupPath(file));
    return true;
  });
}
