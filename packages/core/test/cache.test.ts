import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_FILE_NAME,
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
      snapshots: [snapshot()]
    });
    const raw = await readFile(path.join(directory, CACHE_FILE_NAME), "utf8");
    expect(raw).toContain('"version":1');
    expect(raw.indexOf('"snapshots"')).toBeLessThan(raw.indexOf('"version"'));
  });

  it("rejects corrupt and out of bounds cache data", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, CACHE_FILE_NAME), "{broken", "utf8");
    expect(await readSnapshotCache(directory)).toEqual({ ok: false, reason: "corrupt" });
    await writeFile(
      path.join(directory, CACHE_FILE_NAME),
      JSON.stringify({ snapshots: [snapshot({ value: 101 })], version: 1 }),
      "utf8"
    );
    expect(await readSnapshotCache(directory)).toEqual({ ok: false, reason: "corrupt" });
    await expect(writeSnapshotCache([snapshot({ value: -1 })], directory)).rejects.toThrow();
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
