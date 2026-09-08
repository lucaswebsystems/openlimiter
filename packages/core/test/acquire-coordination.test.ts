import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_REFRESH_STALE_SECONDS,
  REFRESH_LOCK_HEARTBEAT_MILLISECONDS,
  REFRESH_LOCK_NAME,
  REFRESH_LOCK_STALE_MILLISECONDS,
  acquireRefreshLock,
  clearRefreshSpawnFailure,
  readRefreshSpawnFailure,
  cacheAgeSeconds,
  mergeAcquiredSnapshots,
  readSnapshotCache,
  writeSnapshotCache,
  desktopHoldsCache,
  refreshLockHeld,
  shouldStartRefresh,
  spawnDetachedRefresh,
  withWriter,
  type Snapshot
} from "../src/index.js";
import { snapshot } from "./helpers.js";

const NOW = "2026-01-01T00:10:00.000Z";

function rowObservedAt(observedAt: string, writer?: "desktop" | "cli"): Snapshot {
  const base = snapshot({
    provider: "CODEX",
    meter: "FIVE_HOUR",
    observedAt,
    expiresAt: "2026-01-01T01:00:00.000Z"
  });
  return writer === undefined ? base : { ...base, writer };
}

let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), "openlimiter-coord-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("desktop coordination", () => {
  it("stands down while a desktop is keeping the cache fresh", () => {
    const rows = [rowObservedAt("2026-01-01T00:05:00.000Z", "desktop")];
    expect(desktopHoldsCache(rows, NOW)).toBe(true);
    expect(shouldStartRefresh(rows, NOW)).toEqual({
      refresh: false,
      reason: "desktop_running"
    });
  });

  it("polls again once the desktop's last write is older than the interval", () => {
    const rows = [rowObservedAt("2025-12-31T23:50:00.000Z", "desktop")];
    expect(desktopHoldsCache(rows, NOW)).toBe(false);
    expect(shouldStartRefresh(rows, NOW)).toEqual({ refresh: true });
  });

  it("reads an unmarked cache as nobody's, which is what it always was", () => {
    /* Every row written before this field existed carries no marker. Reading
       that as "a desktop is running" would stop a machine with no desktop from
       ever refreshing again. */
    const rows = [rowObservedAt("2026-01-01T00:05:00.000Z")];
    expect(desktopHoldsCache(rows, NOW)).toBe(false);
  });

  it("ignores a marker stamped in the future", () => {
    const rows = [rowObservedAt("2026-01-01T02:00:00.000Z", "desktop")];
    expect(desktopHoldsCache(rows, NOW)).toBe(false);
  });

  it("does not let this tool's own writes silence it", () => {
    const rows = withWriter([rowObservedAt("2026-01-01T00:09:00.000Z")], "cli");
    expect(rows[0]?.writer).toBe("cli");
    expect(desktopHoldsCache(rows, NOW)).toBe(false);
  });
});

describe("cache freshness", () => {
  it("measures age from the newest row", () => {
    expect(cacheAgeSeconds([
      rowObservedAt("2026-01-01T00:09:00.000Z"),
      rowObservedAt("2026-01-01T00:00:00.000Z")
    ], NOW)).toBe(60);
    expect(cacheAgeSeconds([], NOW)).toBeNull();
  });

  it("refreshes only once the cache is older than a minute", () => {
    expect(shouldStartRefresh(
      [rowObservedAt("2026-01-01T00:09:30.000Z")],
      NOW
    )).toEqual({ refresh: false, reason: "fresh" });
    expect(shouldStartRefresh(
      [rowObservedAt("2026-01-01T00:08:00.000Z")],
      NOW
    )).toEqual({ refresh: true });
    expect(CACHE_REFRESH_STALE_SECONDS).toBe(60);
  });

  it("refreshes when there is nothing cached at all", () => {
    expect(shouldStartRefresh([], NOW)).toEqual({ refresh: true });
  });
});

describe("the refresh lock", () => {
  it("lets exactly one holder through and releases only its own", async () => {
    const directory = await temporaryDirectory();
    const first = await acquireRefreshLock(directory);
    expect(first.ok).toBe(true);
    const second = await acquireRefreshLock(directory);
    expect(second).toEqual({ ok: false, reason: "held" });
    expect(await refreshLockHeld(directory)).toBe(true);
    if (first.ok) await first.release();
    expect(await refreshLockHeld(directory)).toBe(false);
    const third = await acquireRefreshLock(directory);
    expect(third.ok).toBe(true);
    if (third.ok) await third.release();
  });

  it("keeps a long round alive through its heartbeat", async () => {
    const directory = await temporaryDirectory();
    const lockFile = path.join(directory, REFRESH_LOCK_NAME);
    const taken = await acquireRefreshLock(directory);
    expect(taken.ok).toBe(true);
    const contents = await readFile(lockFile, "utf8");
    /* A round of seven providers, two of them two hop, can outlast any fixed
       duration bound. Liveness is the question, so the heartbeat answers it. */
    const beat = new Date(Date.now() + REFRESH_LOCK_HEARTBEAT_MILLISECONDS);
    await utimes(lockFile, beat, beat);
    expect(await refreshLockHeld(
      directory,
      Date.now() + REFRESH_LOCK_STALE_MILLISECONDS + 1_000
    )).toBe(true);
    /* The heartbeat touches the file and never rewrites it, because the token
       inside is what proves ownership at every write. */
    expect(await readFile(lockFile, "utf8")).toBe(contents);
    expect(taken.ok ? await taken.stillOwned() : false).toBe(true);
    if (taken.ok) await taken.release();
  });

  it("knows it lost the lock before it writes anything", async () => {
    const directory = await temporaryDirectory();
    const mine = await acquireRefreshLock(directory);
    expect(mine.ok).toBe(true);
    expect(mine.ok ? await mine.stillOwned() : false).toBe(true);
    await writeFile(
      path.join(directory, REFRESH_LOCK_NAME),
      JSON.stringify({ at: 1, id: "other", pid: 2 }),
      "utf8"
    );
    expect(mine.ok ? await mine.stillOwned() : true).toBe(false);
    if (mine.ok) await mine.release();
  });

  it("waits six heartbeats before calling a lock abandoned", () => {
    expect(REFRESH_LOCK_HEARTBEAT_MILLISECONDS).toBe(10_000);
    expect(REFRESH_LOCK_STALE_MILLISECONDS).toBe(60_000);
    expect(REFRESH_LOCK_STALE_MILLISECONDS / REFRESH_LOCK_HEARTBEAT_MILLISECONDS)
      .toBeGreaterThanOrEqual(6);
  });

  it("reclaims a lock a dead process left behind", async () => {
    const directory = await temporaryDirectory();
    const lockFile = path.join(directory, REFRESH_LOCK_NAME);
    await writeFile(lockFile, JSON.stringify({ at: 0, id: "gone", pid: 1 }), "utf8");
    const stale = new Date(Date.now() - REFRESH_LOCK_STALE_MILLISECONDS - 1_000);
    await utimes(lockFile, stale, stale);
    expect(await refreshLockHeld(directory)).toBe(false);
    const taken = await acquireRefreshLock(directory);
    expect(taken.ok).toBe(true);
    /* The reclaim replaced the file rather than reusing it, so the new holder
       owns a lock it can prove is its own. */
    expect((await stat(lockFile)).size).toBeGreaterThan(0);
    if (taken.ok) await taken.release();
  });

  it("does not release a lock that was taken over by somebody else", async () => {
    const directory = await temporaryDirectory();
    const mine = await acquireRefreshLock(directory);
    expect(mine.ok).toBe(true);
    const lockFile = path.join(directory, REFRESH_LOCK_NAME);
    await writeFile(lockFile, JSON.stringify({ at: 1, id: "other", pid: 2 }), "utf8");
    if (mine.ok) await mine.release();
    expect(await refreshLockHeld(directory)).toBe(true);
  });
});

describe("writing what a round acquired", () => {
  function row(
    meter: string,
    observedAt: string,
    writer?: "desktop" | "cli"
  ): Snapshot {
    const base = snapshot({
      provider: "CODEX",
      meter,
      observedAt,
      expiresAt: "2026-01-01T09:00:00.000Z",
      resetAt: null
    });
    return writer === undefined ? base : { ...base, writer };
  }

  it("keeps a desktop row that appeared while this round was running", async () => {
    const directory = await temporaryDirectory();
    /*
     * The refresh lock coordinates other copies of this tool and means nothing
     * to the desktop, which is a separate process. So the round reads, the
     * desktop writes a fresher row, and the round then tries to write. The
     * newer row has to survive that.
     */
    await writeSnapshotCache(
      [row("FIVE_HOUR", "2026-01-01T00:09:00.000Z", "desktop")],
      directory
    );
    const written = await mergeAcquiredSnapshots({
      ok: true,
      provider: "CODEX",
      observedAt: "2026-01-01T00:00:00.000Z",
      snapshots: [row("FIVE_HOUR", "2026-01-01T00:00:00.000Z", "cli")]
    }, directory);
    expect(written.deferred).toBe(1);
    expect(written.taken).toBe(0);
    const cached = await readSnapshotCache(directory);
    const kept = cached.ok ? cached.snapshots : [];
    expect(kept).toHaveLength(1);
    expect(kept[0]?.writer).toBe("desktop");
    expect(kept[0]?.observedAt).toBe("2026-01-01T00:09:00.000Z");
  });

  it("takes its own row when it is the newer one", async () => {
    const directory = await temporaryDirectory();
    await writeSnapshotCache(
      [row("FIVE_HOUR", "2026-01-01T00:00:00.000Z", "desktop")],
      directory
    );
    const written = await mergeAcquiredSnapshots({
      ok: true,
      provider: "CODEX",
      observedAt: "2026-01-01T00:09:00.000Z",
      snapshots: [row("FIVE_HOUR", "2026-01-01T00:09:00.000Z", "cli")]
    }, directory);
    expect(written.deferred).toBe(0);
    const cached = await readSnapshotCache(directory);
    expect(cached.ok ? cached.snapshots[0]?.writer : null).toBe("cli");
  });

  it("leaves a tie with the row that is already visible", async () => {
    const directory = await temporaryDirectory();
    await writeSnapshotCache(
      [row("FIVE_HOUR", "2026-01-01T00:05:00.000Z", "desktop")],
      directory
    );
    const written = await mergeAcquiredSnapshots({
      ok: true,
      provider: "CODEX",
      observedAt: "2026-01-01T00:05:00.000Z",
      snapshots: [row("FIVE_HOUR", "2026-01-01T00:05:00.000Z", "cli")]
    }, directory);
    expect(written.deferred).toBe(1);
    const cached = await readSnapshotCache(directory);
    expect(cached.ok ? cached.snapshots[0]?.writer : null).toBe("desktop");
  });

  it("never deletes a deferred row while dropping the ones it owns", async () => {
    const directory = await temporaryDirectory();
    await writeSnapshotCache([
      row("FIVE_HOUR", "2026-01-01T00:09:00.000Z", "desktop"),
      row("SEVEN_DAY", "2026-01-01T00:00:00.000Z", "cli")
    ], directory);
    const written = await mergeAcquiredSnapshots({
      ok: true,
      provider: "CODEX",
      observedAt: "2026-01-01T00:05:00.000Z",
      snapshots: [row("SEVEN_DAY", "2026-01-01T00:05:00.000Z", "cli")]
    }, directory);
    expect(written.deferred).toBe(0);
    const cached = await readSnapshotCache(directory);
    const meters = (cached.ok ? cached.snapshots : [])
      .map((entry) => entry.meter)
      .sort();
    /* The desktop's five hour row is untouched, and this round's seven day row
       replaced its own older one. */
    expect(meters).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
  });
});

describe("starting a refresh behind a render", () => {
  const spawnOptions = {
    nodeExecutable: "/usr/bin/node",
    openLimiterScript: "/opt/openlimiter/bin.js"
  };

  it("hands the operating system a detached refresh and returns", async () => {
    const directory = await temporaryDirectory();
    const calls: { executable: string; argumentsList: readonly string[] }[] = [];
    const result = await spawnDetachedRefresh({
      snapshots: [],
      now: NOW,
      stateDirectory: directory,
      ...spawnOptions,
      spawn: (executable, argumentsList) => {
        calls.push({ executable, argumentsList });
      }
    });
    expect(result).toEqual({ spawned: true });
    expect(calls).toEqual([{
      executable: "/usr/bin/node",
      argumentsList: ["/opt/openlimiter/bin.js", "refresh", "--detached"]
    }]);
  });

  it("starts nothing while the cache is fresh or a desktop is running", async () => {
    const directory = await temporaryDirectory();
    let spawned = 0;
    const spawn = (): void => {
      spawned += 1;
    };
    expect(await spawnDetachedRefresh({
      snapshots: [rowObservedAt("2026-01-01T00:09:30.000Z")],
      now: NOW,
      stateDirectory: directory,
      ...spawnOptions,
      spawn
    })).toEqual({ spawned: false, reason: "fresh" });
    expect(await spawnDetachedRefresh({
      snapshots: [rowObservedAt("2026-01-01T00:05:00.000Z", "desktop")],
      now: NOW,
      stateDirectory: directory,
      ...spawnOptions,
      spawn
    })).toEqual({ spawned: false, reason: "desktop_running" });
    expect(spawned).toBe(0);
  });

  it("starts nothing while another refresh holds the lock", async () => {
    const directory = await temporaryDirectory();
    const held = await acquireRefreshLock(directory);
    expect(held.ok).toBe(true);
    let spawned = 0;
    expect(await spawnDetachedRefresh({
      snapshots: [],
      now: NOW,
      stateDirectory: directory,
      ...spawnOptions,
      spawn: () => {
        spawned += 1;
      }
    })).toEqual({ spawned: false, reason: "already_running" });
    expect(spawned).toBe(0);
    if (held.ok) await held.release();
  });

  it("reports rather than throws when the spawn itself fails", async () => {
    const directory = await temporaryDirectory();
    expect(await spawnDetachedRefresh({
      snapshots: [],
      now: NOW,
      stateDirectory: directory,
      ...spawnOptions,
      spawn: () => {
        throw new Error("no process for you");
      }
    })).toEqual({ spawned: false, reason: "failed" });
    expect(await readRefreshSpawnFailure(directory)).toBe(NOW);
  });

  it("remembers a child that failed to start after the render returned", async () => {
    const directory = await temporaryDirectory();
    /*
     * A detached spawn reports a missing executable asynchronously, after the
     * status line has already printed. There is nobody left to tell, so the
     * fact is written down and doctor reads it back.
     */
    let report: (() => void) | undefined;
    const result = await spawnDetachedRefresh({
      snapshots: [],
      now: NOW,
      stateDirectory: directory,
      ...spawnOptions,
      spawn: (_executable, _argumentsList, options) => {
        report = options.onError;
      }
    });
    expect(result).toEqual({ spawned: true });
    expect(await readRefreshSpawnFailure(directory)).toBeNull();
    expect(report).toBeTypeOf("function");
    report?.();
    /* The record is written asynchronously after the report; wait for it
       rather than for a fixed number of milliseconds. */
    let recorded = await readRefreshSpawnFailure(directory);
    for (let attempt = 0; attempt < 200 && recorded === null; attempt++) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      recorded = await readRefreshSpawnFailure(directory);
    }
    expect(recorded).toBe(NOW);
    await clearRefreshSpawnFailure(directory);
    expect(await readRefreshSpawnFailure(directory)).toBeNull();
  });
});
