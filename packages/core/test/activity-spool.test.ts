import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, lstatSync, symlinkSync, linkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readActivitySpool, writeActivityEvent } from "../src/activity/spool.js";
import { MAX_ACTIVITY_EVENT_AGE_MS, MAX_ACTIVITY_SPOOL_BYTES, type ActivityEvent } from "../src/activity/contract.js";

const roots: string[] = [];
const now = Date.now();
const event = (sequence = 0): ActivityEvent => ({
  version: 1, eventId: "event", sessionId: "session", sequence, agent: "codex",
  observedAt: new Date(now).toISOString(), state: "busy", source: "hook", confidence: "explicit", process: { ppid: 42 }
});
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "openlimiter-spool-"));
  roots.push(directory);
  // ACL invocation is tested separately; this seam never changes the host platform.
  return { directory, now, protectWindowsDirectory: async () => undefined };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("activity spool", () => {
  it.each(["root", "ancestor", "missing root"])("publishes and reads through a symlinked state %s without trusting links below it", async (kind) => {
    const options = setup();
    const aliases = setup();
    const alias = path.join(aliases.directory, "linked-root");
    symlinkSync(options.directory, alias, process.platform === "win32" ? "junction" : "dir");
    const directory = kind === "root" ? alias : path.join(alias, "state");
    if (kind === "ancestor") mkdirSync(directory);
    expect(readActivitySpool(directory, now)).toEqual({ events: [], skipped: 0 });
    const stored = await writeActivityEvent(event(), { ...options, directory });
    expect(readActivitySpool(directory, now)).toEqual({ events: [stored], skipped: 0 });
    expect(readActivitySpool(kind === "root" ? options.directory : path.join(options.directory, "state"), now).events).toEqual([stored]);

    rmSync(path.join(directory, "activity"), { recursive: true });
    const outside = path.join(aliases.directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(directory, "activity"), process.platform === "win32" ? "junction" : "dir");
    await expect(writeActivityEvent(event(), { ...options, directory })).rejects.toThrow("unsafe directory");
    expect(readActivitySpool(directory, now)).toEqual({ events: [], skipped: 1 });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("publishes complete files, preserves opaque IDs, and allocates ordered sequences across concurrent writers", async () => {
    const options = setup();
    const results = await Promise.all(Array.from({ length: 12 }, () => writeActivityEvent(event(), options)));
    const files = readdirSync(path.join(options.directory, "activity")).filter((file) => file !== ".acl-verified");
    expect(files).toHaveLength(12);
    expect(files.every((file) => file.endsWith(".json"))).toBe(true);
    expect(new Set(results.map((value) => value.sequence)).size).toBe(12);
    const read = readActivitySpool(options.directory, now);
    expect(read.skipped).toBe(0);
    expect(read.events.map((value) => value.sequence)).toEqual(results.map((value) => value.sequence).sort((a, b) => a - b));
    expect(read.events.every((value) => value.sessionId === "session")).toBe(true);
    for (const file of files) expect(() => JSON.parse(readFileSync(path.join(options.directory, "activity", file), "utf8"))).not.toThrow();
  });

  it("refuses invalid and oversized events without creating a spool", async () => {
    const options = setup();
    await expect(writeActivityEvent({ ...event(), sessionId: "x".repeat(9000) }, options)).rejects.toThrow();
    expect(readdirSync(options.directory)).toEqual([]);
    await expect(writeActivityEvent({ ...event(), process: { pid: 5, startedAt: event().observedAt } }, options)).rejects.toThrow();
  });

  it("removes only old owned files, including abandoned temporary files", async () => {
    const options = setup();
    await writeActivityEvent(event(), options);
    const spool = path.join(options.directory, "activity");
    const old = path.join(spool, readdirSync(spool).find((file) => file.endsWith(".json"))!);
    const temporary = path.join(spool, ".aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.tmp");
    writeFileSync(temporary, "partial", { mode: 0o600 });
    const date = new Date(now - MAX_ACTIVITY_EVENT_AGE_MS - 1);
    for (const file of [old, temporary]) utimesSync(file, date, date);
    await writeActivityEvent(event(), options);
    expect(readdirSync(spool).filter((file) => file !== ".acl-verified")).toHaveLength(1);
  });

  it("recovers a writer lock stranded by a killed hook but waits for a live one", async () => {
    const options = setup();
    await writeActivityEvent(event(), options);
    const lock = path.join(options.directory, "activity", ".writer");
    mkdirSync(lock);
    await expect(writeActivityEvent(event(), options)).rejects.toThrow();
    const stranded = new Date(now - 60_000);
    utimesSync(lock, stranded, stranded);
    await writeActivityEvent(event(), options);
    expect(readdirSync(path.join(options.directory, "activity"))).not.toContain(".writer");
  });

  it("allocates sequences from names and times without opening records", async () => {
    const options = setup();
    await writeActivityEvent(event(), options);
    const spool = path.join(options.directory, "activity");
    const first = readdirSync(spool).find((file) => file.endsWith(".json"))!;
    // A stale observedAt inside a fresh file: only the reader may judge it.
    writeFileSync(path.join(spool, first), JSON.stringify({ ...event(), observedAt: new Date(now - MAX_ACTIVITY_EVENT_AGE_MS - 1).toISOString() }), { mode: 0o600 });
    await writeActivityEvent(event(), options);
    expect(readdirSync(spool)).toContain(first);
    expect(readActivitySpool(options.directory, now).skipped).toBe(1);
  });

  it("counts malformed, padded, unexpected, hard linked and partial files without throwing", async () => {
    const options = setup();
    await writeActivityEvent(event(), options);
    const spool = path.join(options.directory, "activity");
    const name = (id: number) => path.join(spool, `000000000000000${id}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json`);
    writeFileSync(name(1), "{", { mode: 0o600 });
    writeFileSync(name(2), " ".repeat(8193), { mode: 0o600 });
    writeFileSync(path.join(spool, ".partial.tmp"), "{", { mode: 0o600 });
    mkdirSync(name(3));
    const outside = path.join(options.directory, "outside");
    writeFileSync(outside, JSON.stringify(event()), { mode: 0o600 });
    linkSync(outside, name(4));
    expect(readActivitySpool(options.directory, now)).toMatchObject({ skipped: 5, events: [expect.objectContaining({ state: "busy" })] });
    await expect(writeActivityEvent(event(), options)).rejects.toThrow();
  });

  it("refuses owned directory junctions and path escapes", async () => {
    const options = setup();
    const outside = path.join(options.directory, "outside");
    mkdirSync(outside);
    symlinkSync(outside, path.join(options.directory, "activity"), process.platform === "win32" ? "junction" : "dir");
    await expect(writeActivityEvent(event(), options)).rejects.toThrow();
    expect(readActivitySpool(options.directory, now).skipped).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
    await expect(writeActivityEvent(event(), { ...options, directory: options.directory + path.sep + ".." })).rejects.toThrow();
  });

  it("keeps the aggregate cap even when another writer fills the remaining space", async () => {
    const options = setup();
    await writeActivityEvent(event(), options);
    const spool = path.join(options.directory, "activity");
    for (const file of readdirSync(spool)) rmSync(path.join(spool, file));
    for (let index = 0; index < MAX_ACTIVITY_SPOOL_BYTES / 8192; index++) {
      writeFileSync(path.join(spool, String(index)), Buffer.alloc(8192), { mode: 0o600 });
    }
    await expect(writeActivityEvent(event(), options)).rejects.toThrow("spool full");
    expect(readdirSync(spool).filter((file) => file !== ".acl-verified")).toHaveLength(2048);
  });

  it("does not publish after cancellation", async () => {
    const options = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(writeActivityEvent(event(), { ...options, signal: controller.signal })).rejects.toThrow();
    expect(readdirSync(options.directory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("uses owner only POSIX directory and file permissions", async () => {
    const options = setup();
    await writeActivityEvent(event(), options);
    const spool = path.join(options.directory, "activity");
    expect(lstatSync(spool).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(spool, readdirSync(spool)[0]!)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform !== "win32")("fails closed when the Windows ACL helper is absent or fails", async () => {
    const options = setup();
    await expect(writeActivityEvent(event(), { directory: options.directory, now })).rejects.toThrow("ACL helper required");
    await expect(writeActivityEvent(event(), { ...options, protectWindowsDirectory: async () => { throw new Error("ACL denied"); } })).rejects.toThrow("ACL denied");
    expect(readdirSync(path.join(options.directory, "activity"))).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("reuses a fresh regular Windows ACL stamp without calling the helper", async () => {
    const options = setup();
    const protectWindowsDirectory = vi.fn(async () => undefined);
    await writeActivityEvent(event(), { ...options, protectWindowsDirectory });
    expect(protectWindowsDirectory).toHaveBeenCalledTimes(1);
    protectWindowsDirectory.mockClear();
    await writeActivityEvent(event(), { ...options, protectWindowsDirectory });
    expect(protectWindowsDirectory).not.toHaveBeenCalled();
    expect(readActivitySpool(options.directory, now)).toMatchObject({ skipped: 0 });
  });

  it.skipIf(process.platform !== "win32").each(["missing", "expired", "directory", "symlink", "hardlink", "oversized"])("verifies and atomically replaces a %s Windows ACL stamp", async (kind) => {
    const options = setup();
    const spool = path.join(options.directory, "activity");
    mkdirSync(spool);
    const stamp = path.join(spool, ".acl-verified");
    const outside = path.join(options.directory, "outside");
    if (kind === "directory") mkdirSync(stamp);
    if (kind === "symlink") { mkdirSync(outside); symlinkSync(outside, stamp, "junction"); }
    if (kind === "hardlink") { writeFileSync(outside, "unchanged"); linkSync(outside, stamp); }
    if (kind === "oversized") writeFileSync(stamp, Buffer.alloc(8193));
    if (kind === "expired") {
      writeFileSync(stamp, "");
      const old = new Date(now - MAX_ACTIVITY_EVENT_AGE_MS - 1);
      utimesSync(stamp, old, old);
    }
    const protectWindowsDirectory = vi.fn(async () => {
      expect(readdirSync(spool).filter((file) => file.endsWith(".json"))).toEqual([]);
    });
    await writeActivityEvent(event(), { ...options, protectWindowsDirectory });
    expect(protectWindowsDirectory).toHaveBeenCalledTimes(1);
    expect(lstatSync(stamp).isFile()).toBe(true);
    expect(lstatSync(stamp).isSymbolicLink()).toBe(false);
    expect(lstatSync(stamp).nlink).toBe(1);
    expect(lstatSync(stamp).mtimeMs).toBeGreaterThan(now - MAX_ACTIVITY_EVENT_AGE_MS);
    expect(readdirSync(spool).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    expect(readActivitySpool(options.directory, now).events).toHaveLength(1);
    if (kind === "symlink") expect(readdirSync(outside)).toEqual([]);
    if (kind === "hardlink") expect(readFileSync(outside, "utf8")).toBe("unchanged");
  });
});
