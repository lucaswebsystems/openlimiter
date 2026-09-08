import { readFile, rm, writeFile } from "node:fs/promises";
import { writeFileAtomically } from "@openlimiter/core";

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

export async function isOwned(file: string, current: string, marker: boolean): Promise<boolean> {
  const saved = await backup(file);
  return marker && saved !== null && saved.installed === current;
}

export async function writeOwned(file: string, original: string | null, installed: string): Promise<void> {
  const saved = await backup(file);
  if (saved !== null) {
    if (saved.installed === original && original === installed) return;
    if (saved.original !== original || saved.installed !== installed) throw new Error("Configuration changed");
  } else {
    // Exclusive creation guarantees that a repeated install cannot replace the
    // original bytes. A write failure leaves the recoverable backup in place.
    await writeFile(backupPath(file), JSON.stringify({ version: 1, original, installed } satisfies Backup), { flag: "wx", mode: 0o600 });
  }
  if (await readOptional(file) !== original) throw new Error("Configuration changed");
  await writeFileAtomically(file, installed);
  if (await readFile(file, "utf8") !== installed) throw new Error("Configuration changed");
}

export async function restoreOwned(file: string, current: string, marker: boolean): Promise<boolean> {
  if (!(await isOwned(file, current, marker))) return false;
  const saved = (await backup(file))!;
  if (saved.original === null) await rm(file);
  else await writeFileAtomically(file, saved.original);
  if (await readOptional(file) !== saved.original) throw new Error("Configuration changed");
  await rm(backupPath(file));
  return true;
}
