import type { Snapshot } from "./generated/core";

/**
 * The snapshot cache, as a browser sees it.
 *
 * The real one in packages/core reads a file out of the operating system state
 * directory. A browser tab has no such directory and no such file, so this
 * reports exactly what the core reports when the file is not there: a missing
 * cache. Nothing is invented, nothing is zero, and every caller that would have
 * read quota from disk falls back to whatever the reader pasted in instead.
 *
 * This is the only module in the engine that is written rather than mirrored,
 * and it exists so that packages/adapters can be mirrored verbatim.
 */
export type CacheReadResult =
  | { ok: true; snapshots: Snapshot[]; dropped: number }
  | { ok: false; reason: "missing" | "corrupt" | "unsafe" };

/*
 * The parameter is accepted so the signature matches the real one, and it is
 * never read, because a browser has no state directory to point it at.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function readSnapshotCache(directory?: string): Promise<CacheReadResult> {
  return { ok: false, reason: "missing" };
}
