import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_FILE_NAME,
  CACHE_LOCK_NAME,
  LOCK_STALE_MILLISECONDS,
  mergeSnapshotCache,
  readSnapshotCache,
  resolveStateDirectory,
  writeSnapshotCache
} from "../src/index.js";
import { snapshot } from "./helpers.js";

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "openlimiter-test-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("snapshot cache", () => {
  it("resolves one platform state directory", () => {
    expect(resolveStateDirectory({
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\SyntheticState" },
      homeDirectory: "C:\\SyntheticHome"
    })).toBe(path.join("C:\\SyntheticState", "openlimiter"));
    expect(resolveStateDirectory({
      platform: "linux",
      environment: { XDG_STATE_HOME: "/synthetic/state" },
      homeDirectory: "/synthetic/home"
    })).toBe(path.join("/synthetic/state", "openlimiter"));
    expect(resolveStateDirectory({
      platform: "darwin",
      environment: {},
      homeDirectory: "/synthetic/home"
    })).toBe(path.join("/synthetic/home", "Library", "Application Support", "openlimiter"));
  });

  it("writes atomically and reads canonical validated snapshots", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "state");
    await writeSnapshotCache([snapshot()], directory);
    expect(await readSnapshotCache(directory)).toEqual({
      ok: true,
      snapshots: [snapshot()],
      dropped: 0
    });
    const raw = await readFile(path.join(directory, CACHE_FILE_NAME), "utf8");
    expect(raw).toContain('"version":1');
    expect(raw.indexOf('"snapshots"')).toBeLessThan(raw.indexOf('"version"'));
  });

  it("rejects corrupt cache data and out of bounds writes", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, CACHE_FILE_NAME), "{broken", "utf8");
    expect(await readSnapshotCache(directory)).toEqual({ ok: false, reason: "corrupt" });
    await writeFile(
      path.join(directory, CACHE_FILE_NAME),
      JSON.stringify({ snapshots: "not an array", version: 1 }),
      "utf8"
    );
    expect(await readSnapshotCache(directory)).toEqual({ ok: false, reason: "corrupt" });
    await expect(writeSnapshotCache([snapshot({ value: -1 })], directory)).rejects.toThrow();
  });

  it("drops one out of bounds row and keeps every other row", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, CACHE_FILE_NAME),
      JSON.stringify({
        snapshots: [
          snapshot({ value: 101 }),
          snapshot({ meter: "SEVEN_DAY", value: 64 })
        ],
        version: 1
      }),
      "utf8"
    );
    expect(await readSnapshotCache(directory)).toEqual({
      ok: true,
      snapshots: [snapshot({ meter: "SEVEN_DAY", value: 64 })],
      dropped: 1
    });
  });

  it("reclaims a stale lock instead of freezing the cache", async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, CACHE_LOCK_NAME);
    await writeFile(
      lockPath,
      JSON.stringify({ at: Date.now() - LOCK_STALE_MILLISECONDS - 60_000, pid: 1 }),
      "utf8"
    );
    await writeSnapshotCache([snapshot()], directory);
    const result = await readSnapshotCache(directory);
    expect(result.ok).toBe(true);
    await expect(access(lockPath)).rejects.toThrow();
  });

  it("reclaims a stale lock that carries no owner stamp", async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, CACHE_LOCK_NAME);
    await writeFile(lockPath, "", "utf8");
    const stale = new Date(Date.now() - LOCK_STALE_MILLISECONDS - 60_000);
    await utimes(lockPath, stale, stale);
    await writeSnapshotCache([snapshot()], directory);
    expect((await readSnapshotCache(directory)).ok).toBe(true);
  });

  it("lets several concurrent writers through", async () => {
    const directory = await temporaryDirectory();
    const writers = Array.from({ length: 8 }, (_unused, index) =>
      writeSnapshotCache([snapshot({ value: index + 1 })], directory));
    const settled = await Promise.allSettled(writers);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(8);
    const result = await readSnapshotCache(directory);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.snapshots : []).toHaveLength(1);
  });

  it("keeps every concurrent merge instead of losing rows", async () => {
    const directory = await temporaryDirectory();
    const merges = Array.from({ length: 8 }, (_unused, index) =>
      mergeSnapshotCache(
        [snapshot({ meter: "W_" + String(index), value: index })],
        directory
      ));
    const settled = await Promise.allSettled(merges);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(8);
    const result = await readSnapshotCache(directory);
    expect(result.ok ? result.snapshots : []).toHaveLength(8);
  });

  it("skips the write when a merge changes nothing", async () => {
    const directory = await temporaryDirectory();
    expect((await mergeSnapshotCache([snapshot()], directory)).written).toBe(true);
    expect((await mergeSnapshotCache([snapshot()], directory)).written).toBe(false);
    expect((await mergeSnapshotCache([snapshot({ value: 51 })], directory)).written)
      .toBe(true);
  });

  it("refuses a cache path that is not a regular file", async () => {
    const directory = await temporaryDirectory();
    await mkdir(path.join(directory, CACHE_FILE_NAME));
    expect((await readSnapshotCache(directory)).ok).toBe(false);
  });

  it("rejects a symbolic state directory", async () => {
    const parent = await temporaryDirectory();
    const target = path.join(parent, "target");
    const link = path.join(parent, "link");
    await mkdir(target);
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(await readSnapshotCache(link)).toEqual({ ok: false, reason: "unsafe" });
    await expect(writeSnapshotCache([snapshot()], link)).rejects.toThrow();
  });

  it("rejects a symbolic cache file", async () => {
    const parent = await temporaryDirectory();
    const directory = path.join(parent, "state");
    await mkdir(directory);
    const target = process.platform === "win32"
      ? path.join(parent, "target")
      : path.join(parent, "target.json");
    if (process.platform === "win32") {
      await mkdir(target);
    } else {
      await writeFile(target, "{}", "utf8");
    }
    await symlink(
      target,
      path.join(directory, CACHE_FILE_NAME),
      process.platform === "win32" ? "junction" : "file"
    );
    expect(await readSnapshotCache(directory)).toEqual({ ok: false, reason: "unsafe" });
    await expect(writeSnapshotCache([snapshot()], directory)).rejects.toThrow();
  });
});
