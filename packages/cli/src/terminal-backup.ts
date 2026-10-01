import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { acquireRefreshLock, writeFileAtomically } from "@openlimiter/core";

/**
 * `drifted` is set once a reinstall absorbed edits the person made after an
 * install. From then on `original` predates those edits, so uninstall may only
 * put OpenLimiter's own keys back. A backup without the field never drifted.
 */
interface Backup { version: 1; original: string | null; installed: string; drifted?: true }
const backupPath = (file: string): string => `${file}.openlimiter-backup.json`;

export async function readOptional(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function backup(file: string): Promise<Backup | null> {
  const raw = await readOptional(backupPath(file));
  if (raw === null) return null;
  const value = JSON.parse(raw) as Backup;
  if (value.version !== 1 || !(value.original === null || typeof value.original === "string") || typeof value.installed !== "string" ||
    !(value.drifted === undefined || value.drifted === true)) throw new Error("Invalid backup");
  return value;
}

/** Recover the first configuration, including across reinstalls and state moves. */
export async function originalConfiguration(file: string, current: string | null): Promise<string | null> {
  const saved = await backup(file);
  // When no backup exists the current content is the original.
  // When a backup exists, always return the preserved original regardless of
  // whether the host has since edited the file — the original field never
  // changes once it is written.
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

/**
 * Whether uninstall must patch OpenLimiter's keys instead of restoring the
 * original bytes: the file changed since the last write, or an earlier
 * reinstall absorbed such a change.
 */
const drifted = (saved: Backup, current: string | null): boolean => saved.installed !== current || saved.drifted === true;

/** The first configuration when uninstall has to patch rather than restore it, otherwise `undefined`. */
export async function driftedOriginal(file: string, current: string | null): Promise<string | null | undefined> {
  const saved = await backup(file);
  return saved !== null && drifted(saved, current) ? saved.original : undefined;
}

/** Result of an ownership check used during install. */
export type InstallOwnershipResult =
  | { kind: "unowned" }
  | { kind: "owned"; original: string | null }
  | { kind: "drifted"; original: string | null }
  | { kind: "replaced_by_other" };

/**
 * Classify the current ownership state for an install operation on a JSON/TOML
 * config host.
 *
 * - "unowned": no backup and no marker, the file was never touched by us.
 * - "owned": backup present and installed bytes still match, clean reinstall.
 * - "drifted": backup present but host has edited the file since we last wrote
 *   it. The caller should update from current content and refresh installed.
 * - "replaced_by_other": marker present but backup is missing or stale, and
 *   the current statusLine is not an OpenLimiter command. This is the case
 *   where the person replaced our line with their own.
 */
export async function classifyInstallOwnership(
  file: string,
  current: string | null,
  marker: boolean,
  legacyOpenLimiter: boolean
): Promise<InstallOwnershipResult> {
  const saved = await backup(file);
  if (saved === null) {
    // No backup at all: either never installed, or the backup was removed.
    return { kind: "unowned" };
  }
  if (saved.installed === current) {
    // Backup matches exactly — clean owned state.
    return { kind: "owned", original: saved.original };
  }
  // Backup exists but differs from current. The host has edited the file.
  if (!marker && !legacyOpenLimiter) {
    // The marker is gone too and the current statusLine is not ours: the
    // person replaced our content entirely with their own.
    return { kind: "replaced_by_other" };
  }
  // Our marker (or a legacy OpenLimiter command) is still present, but the
  // host also added keys around it. Tolerate the drift.
  return { kind: "drifted", original: saved.original };
}

/**
 * Write `installed` to `file`, updating the backup so that:
 *
 * - When no backup exists yet: `original` is saved and never changed again.
 * - When a backup exists and the host has drifted the file: the backup's
 *   `original` is preserved untouched, and `installed` is updated to the new
 *   content so the next check sees the correct baseline.
 *
 * The concurrency guard re-reads under the lock and refuses if the file
 * changed between the outer read and the write.
 *
 * `priorCurrent` is the content read before the lock was acquired. If the
 * file differs when re-read under the lock, the operation is refused with
 * a "file changed during the operation" error.
 */
export async function writeOwned(file: string, original: string | null, installed: string): Promise<void> {
  await withFileLock(file, async () => {
    const current = await readOptional(file);
    // Concurrency guard: refuse if the file changed between the read outside
    // the lock and this re-read inside it.
    if (current !== original) throw new Error("File changed during the operation, try again");
    // Nothing to write — file is already what we'd produce.
    if (current === installed) return;
    const saved = await backup(file);

    // A reinstall keeps the backup's original and any recorded drift.
    const next: Backup = saved === null ? { version: 1, original, installed } : { ...saved, installed };
    if (saved === null) {
      // Exclusive creation guarantees that a repeated install cannot replace the
      // original bytes. A write failure leaves the recoverable backup in place.
      await writeFile(backupPath(file), JSON.stringify(next), { flag: "wx", mode: 0o600 });
    } else {
      await writeFileAtomically(backupPath(file), JSON.stringify(next));
    }
    await writeFileAtomically(file, installed);
    if (await readFile(file, "utf8") !== installed) throw new Error("File changed during the operation, try again");
  });
}


/**
 * Write `installed` to `file` when the host has edited it since we last wrote
 * it (drift case). The backup's `original` is preserved; `installed` is updated
 * to the new content.
 *
 * `priorCurrent` is the drifted content read before locking. The concurrency
 * guard inside the lock re-reads and refuses if the file changed again.
 */
export async function writeDriftedOwned(file: string, priorCurrent: string | null, installed: string): Promise<void> {
  await withFileLock(file, async () => {
    const current = await readOptional(file);
    if (current !== priorCurrent) throw new Error("File changed during the operation, try again");
    const saved = await backup(file);

    // Preserve the original; update installed to the new content.
    // Record the drift: `original` now predates the person's edits, so a
    // later uninstall must not write those bytes back over them.
    const next: Backup = {
      version: 1,
      original: saved !== null ? saved.original : priorCurrent,
      installed,
      drifted: true
    };

    if (current === installed) {
      // File is already correct but backup.installed may still point to the
      // first-install content. Update the backup so future drift detection
      // compares against the current content and correctly sees "owned".
      if (saved === null || saved.installed !== installed || saved.drifted !== true) {
        await writeFileAtomically(backupPath(file), JSON.stringify(next));
      }
      return;
    }

    await writeFileAtomically(backupPath(file), JSON.stringify(next));
    await writeFileAtomically(file, installed);
    if (await readFile(file, "utf8") !== installed) throw new Error("File changed during the operation, try again");
  });
}

/**
 * Uninstall result for restoreOwned.
 *
 * - "restored_exact": backup.installed matched current; original bytes restored.
 * - "restored_drifted": host edited the file; statusLine key patched on
 *   current content, backup removed.
 * - "not_owned": the file is not ours (no backup, or marker absent).
 * - "concurrent_change": the file changed between the read and the write.
 */
export type RestoreResult =
  | { kind: "restored_exact" }
  | { kind: "restored_drifted" }
  | { kind: "not_owned" }
  | { kind: "concurrent_change"; path: string };

/**
 * Restore a file to its pre-installation state.
 *
 * When the installed bytes still match the current file, the exact original
 * bytes are written back (or the file is removed if the original was null).
 *
 * When the host has edited the file since we installed (drift), the caller
 * supplies the patched content via `driftedContent`. That content is written
 * to the file so the person's other edits are preserved, and the backup is
 * then removed.
 *
 * `current` is the content read before the lock. The guard re-reads under the
 * lock and refuses if the file changed in the meantime.
 */
export async function restoreOwned(
  file: string,
  current: string,
  marker: boolean,
  driftedContent?: string
): Promise<RestoreResult> {
  return await withFileLock(file, async () => {
    const latest = await readOptional(file);
    if (latest !== current) return { kind: "concurrent_change", path: file };
    const saved = await backup(file);
    if (!(marker && saved !== null)) return { kind: "not_owned" };

    if (!drifted(saved, latest)) {
      // Clean case: nothing ever drifted, restore exact original bytes.
      if (saved.original === null) await rm(file);
      else await writeFileAtomically(file, saved.original);
      if (await readOptional(file) !== saved.original) return { kind: "concurrent_change", path: file };
      await rm(backupPath(file));
      return { kind: "restored_exact" };
    }

    // Drift case: the host edited the file. Apply the patched content the
    // caller built from the current file and remove the backup.
    if (driftedContent !== undefined) {
      await writeFileAtomically(file, driftedContent);
      await rm(backupPath(file));
      return { kind: "restored_drifted" };
    }

    // Drifted but no patch provided: treat as concurrent change (caller
    // should have supplied driftedContent if drift was expected).
    return { kind: "concurrent_change", path: file };
  });
}
