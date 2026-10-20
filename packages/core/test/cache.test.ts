import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORITATIVE_CACHE_FILE_NAME,
  CACHE_FILE_NAME,
  CACHE_LOCK_NAME,
  LOCK_STALE_MILLISECONDS,
  mergeAuthoritativeSnapshotCache,
  mergeSnapshotCache,
  readSnapshotCache,
  resolveStateDirectory,
  writeSnapshotCache,
  type Snapshot
} from "../src/index.js";
import { snapshot } from "./helpers.js";

/* The temp root in canonical form, which is the form the product compares
   against. macOS keeps its temp directory behind a symbolic link (/var is
   /private/var) and the GitHub Windows runner names its own with an 8.3 short
   name; the product refuses both as a link in a protected path, so every
   fixture starts from the canonical spelling and proves the same thing on
   every operating system. */
let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), "openlimiter-test-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
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
      dropped: 0,
      suppressed: 0,
      suppressions: []
    });
    const raw = await readFile(path.join(directory, CACHE_FILE_NAME), "utf8");
    expect(raw).toContain('"version":3');
    /* A document with nothing to withdraw carries no suppressions key at all,
       so a machine that has never drifted keeps writing what it always did. */
    expect(raw).not.toContain('"suppressions"');
    expect(raw.indexOf('"snapshots"')).toBeLessThan(raw.indexOf('"version"'));
  });

  it("migrates version 2 by removing retired Antigravity readings", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, CACHE_FILE_NAME), JSON.stringify({
      version: 2,
      snapshots: [
        snapshot({ provider: "ANTIGRAVITY", source: "internal_payload" }),
        snapshot({ provider: "CLAUDE" })
      ]
    }));

    const first = await readSnapshotCache(directory);
    const second = await readSnapshotCache(directory);
    expect(first.ok && first.snapshots.map((row) => row.provider)).toEqual(["CLAUDE"]);
    expect(second).toEqual(first);
  });

  it("preserves supported availability rows through cache persistence", async () => {
    const directory = await temporaryDirectory();
    const rows = [
      snapshot({
        provider: "OPENROUTER",
        meter: "KEY_LIMIT",
        value: 0,
        availability: "unlimited",
      }),
      snapshot({
        provider: "OPENROUTER",
        meter: "ACCOUNT_BALANCE",
        value: 0,
        availability: "missing_credentials",
      }),
      snapshot({
        provider: "CODEX",
        meter: "CREDITS",
        value: 0,
        availability: "unlimited",
      }),
    ];
    await writeSnapshotCache(rows, directory);
    expect(await readSnapshotCache(directory)).toMatchObject({
      ok: true,
      snapshots: rows,
      dropped: 0,
    });
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
          snapshot({ provider: "CODEX", meter: "SEVEN_DAY", value: 64, window: { kind: "rolling", durationSeconds: 604_800 } })
        ],
        version: 1
      }),
      "utf8"
    );
    /* A version 1 document is still read, and read correctly: it carries no
       suppressions, which is true of it rather than merely assumed. */
    expect(await readSnapshotCache(directory)).toEqual({
      ok: true,
      suppressed: 0,
      suppressions: [],
      snapshots: [snapshot({ provider: "CODEX", meter: "SEVEN_DAY", value: 64, window: { kind: "rolling", durationSeconds: 604_800 } })],
      dropped: 1
    });
  });

  it("drops null and primitive rows while reading a cache", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, CACHE_FILE_NAME),
      JSON.stringify({
        snapshots: [null, "invalid", 42, snapshot({ provider: "CODEX", meter: "SEVEN_DAY", value: 64, window: { kind: "rolling", durationSeconds: 604_800 } })],
        version: 2
      }),
      "utf8"
    );
    expect(await readSnapshotCache(directory)).toEqual({
      ok: true,
      suppressed: 0,
      suppressions: [],
      snapshots: [snapshot({ provider: "CODEX", meter: "SEVEN_DAY", value: 64, window: { kind: "rolling", durationSeconds: 604_800 } })],
      dropped: 3
    });
  });

  it("retires ambiguous OpenRouter credits rows from old cache documents", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, CACHE_FILE_NAME),
      JSON.stringify({
        version: 2,
        snapshots: [
          snapshot({ provider: "OPENROUTER", meter: "CREDITS", value: 50 }),
          snapshot({ provider: "OPENROUTER", meter: "KEY_LIMIT", value: 25 }),
        ],
      }),
      "utf8",
    );
    expect(await readSnapshotCache(directory)).toMatchObject({
      ok: true,
      snapshots: [snapshot({ provider: "OPENROUTER", meter: "KEY_LIMIT", value: 25 })],
      dropped: 1,
    });
  });

  it("drops null and primitive rows during a refresh merge", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, CACHE_FILE_NAME),
      JSON.stringify({
        snapshots: [null, false, "invalid", snapshot({ meter: "FIVE_HOUR", value: 20 })],
        version: 2
      }),
      "utf8"
    );
    const incoming = snapshot({ provider: "CODEX", meter: "SEVEN_DAY", value: 64, window: { kind: "rolling", durationSeconds: 604_800 } });
    const result = await mergeSnapshotCache(
      [incoming],
      directory,
      Date.parse(incoming.observedAt)
    );
    expect(result.merged).toEqual([
      snapshot({ meter: "FIVE_HOUR", value: 20 }),
      incoming
    ]);
    expect(await readSnapshotCache(directory)).toMatchObject({
      ok: true,
      snapshots: result.merged,
      dropped: 0
    });
  });

  it.each(["main then authoritative", "authoritative then main"])(
    "reads each Claude row from the switch's source across stores, %s",
    async (order) => {
      const directory = await temporaryDirectory();
      const main = snapshot({
        meter: "SEVEN_DAY",
        value: 67,
        observedAt: "2026-01-01T00:20:00.000Z",
        expiresAt: "2026-01-08T00:20:00.000Z",
        resetAt: "2026-01-08T00:20:00.000Z",
        window: { kind: "rolling", durationSeconds: 604_800 },
        provenance: { sourceKind: "statusline_payload", observedVia: "claude_code_statusline" }
      });
      const authoritative = snapshot({
        meter: "SEVEN_DAY",
        value: 13,
        observedAt: "2026-01-01T00:10:00.000Z",
        expiresAt: "2026-01-08T00:10:00.000Z",
        resetAt: "2026-01-08T00:10:00.000Z",
        window: { kind: "rolling", durationSeconds: 604_800 },
        source: "internal_payload",
        provenance: { sourceKind: "remote_api", observedVia: "remote_http" }
      });
      const session = snapshot({ meter: "FIVE_HOUR", value: 42 });
      if (order === "main then authoritative") {
        await writeSnapshotCache([main, session], directory);
        await mergeAuthoritativeSnapshotCache([authoritative], directory, "2026-01-01T00:20:00.000Z");
      } else {
        await mergeAuthoritativeSnapshotCache([authoritative], directory, "2026-01-01T00:10:00.000Z");
        await writeSnapshotCache([main, session], directory);
      }
      const read = async (enabled: boolean) => {
        await writeFile(path.join(directory, "claude-poll.json"), JSON.stringify({ version: 1, enabled }));
        const result = await readSnapshotCache(directory);
        return result.ok ? result.snapshots.map((row) => row.meter + " " + String(row.value)) : [];
      };
      /* On: the poll's weekly stands over a newer payload weekly, and the
         payload's session is not read. Off: the session is, and no weekly. */
      expect(await read(true)).toEqual(["SEVEN_DAY 13"]);
      expect(await read(false)).toEqual(["FIVE_HOUR 42"]);
    }
  );

  it("reclaims a stale lock instead of freezing the cache", async () => {
    const directory = await temporaryDirectory();
    const lockPath = path.join(directory, CACHE_LOCK_NAME);
    await mkdir(lockPath);
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: 0, startedAt: Date.now(), token: "stale" }),
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
    await mkdir(lockPath);
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
    /* Lock age is fixed while actual filesystem writes still overlap. Slow
       runners must not turn this merge test into a stale lock test. */
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot().observedAt));
    const merges = Array.from({ length: 8 }, (_unused, index) =>
      mergeSnapshotCache(
        [snapshot({ provider: "MANUAL", meter: "W_" + String(index), value: index })],
        directory
      ));
    const settled = await Promise.allSettled(merges);
    expect(settled.map((entry) => entry.status)).toEqual(Array(8).fill("fulfilled"));
    const result = await readSnapshotCache(directory);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.snapshots : []).toEqual(
      Array.from({ length: 8 }, (_unused, index) =>
        snapshot({ provider: "MANUAL", meter: "W_" + String(index), value: index }))
    );
  });

  it("skips the write when a merge changes nothing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot().observedAt));
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

/*
 * Hotfix 2.1.5, change E. A successful Claude poll replaces that account's
 * complete weekly set in the authoritative store: a weekly the poll no longer
 * reports leaves, while another account and a newer observation stay.
 * Rust twin: native_snapshot.rs, a_successful_claude_poll_replaces_the_accounts_weekly_set.
 */
describe("a successful poll replaces the account weekly set", () => {
  const T0 = "2026-01-01T00:00:00.000Z";
  const T1 = "2026-01-01T00:05:00.000Z";
  const T2 = "2026-01-01T00:10:00.000Z";
  const weekly = (meter: string, accountId: string, observedAt: string, value = 40) => snapshot({
    meter, accountId, value, observedAt, expiresAt: "2026-01-01T01:00:00.000Z", resetAt: "2026-01-05T00:00:00.000Z",
    window: { kind: "rolling", durationSeconds: 604_800 }, source: "internal_payload",
    provenance: { sourceKind: "remote_api", observedVia: "remote_http" }
  });
  const shape = (rows: readonly { meter: string; accountId?: string; value: number }[]) =>
    rows.map((row) => [row.meter, row.accountId, row.value].join(" ")).sort();

  it("drops a weekly the poll no longer reports, for that account only", async () => {
    const directory = await temporaryDirectory();
    await mergeAuthoritativeSnapshotCache([weekly("SEVEN_DAY", "a", T0), weekly("SEVEN_DAY_FABLE", "a", T0), weekly("SEVEN_DAY_FABLE", "b", T0)], directory, T0);
    const rows = await mergeAuthoritativeSnapshotCache([weekly("SEVEN_DAY", "a", T1, 44)], directory, T1,
      { provider: "CLAUDE", accountId: "a", observedAt: T1 });
    expect(shape(rows)).toEqual(["SEVEN_DAY a 44", "SEVEN_DAY_FABLE b 40"]);
  });

  it("an empty weekly set clears the account's older weeklies", async () => {
    const directory = await temporaryDirectory();
    await mergeAuthoritativeSnapshotCache([weekly("SEVEN_DAY", "a", T0), weekly("SEVEN_DAY", "b", T0)], directory, T0);
    const rows = await mergeAuthoritativeSnapshotCache([], directory, T1, { provider: "CLAUDE", accountId: "a", observedAt: T1 });
    expect(shape(rows)).toEqual(["SEVEN_DAY b 40"]);
  });

  it("a late response keeps every newer observation", async () => {
    const directory = await temporaryDirectory();
    await mergeAuthoritativeSnapshotCache([weekly("SEVEN_DAY", "a", T2, 50), weekly("SEVEN_DAY_FABLE", "a", T2, 77)], directory, T2);
    const rows = await mergeAuthoritativeSnapshotCache([weekly("SEVEN_DAY", "a", T1, 44)], directory, T2,
      { provider: "CLAUDE", accountId: "a", observedAt: T1 });
    expect(shape(rows)).toEqual(["SEVEN_DAY a 50", "SEVEN_DAY_FABLE a 77"]);
  });
});

/*
 * 2.1.7: one source per Claude bar. The switch and each row's provenance
 * decide what a surface reads, never the file a row sits in. Rust twin:
 * state.rs, every_shared_claude_source_vector; both read the same cases.
 */
describe("shared Claude source vectors", () => {
  type SourceKind = "statusline_payload" | "remote_api" | "manual_document" | "explicit_ingest";
  interface VectorRow {
    ref: string;
    store: "main" | "authoritative";
    provider?: string;
    accountId?: string | null;
    meter: string;
    sourceKind: SourceKind | null;
    value: number;
    observedAt?: string;
    availability?: string;
    retryAt?: string;
  }
  interface VectorCase {
    id: string;
    switch: "on" | "off" | "missing" | "invalid";
    rows: VectorRow[];
    suppressions?: { provider: string; accountId?: string; suppressedAt: string }[];
    visible: string[];
  }
  const contract = (JSON.parse(readFileSync(path.resolve("packages/core/src/contracts/claude-poll-vectors.json"), "utf8")) as {
    source: { rowDefaults: { provider: string; accountId: string; observedAt: string; resetAt: string }; cases: VectorCase[] };
  }).source;
  const observedVia: Record<SourceKind, string> = {
    statusline_payload: "claude_code_statusline",
    remote_api: "remote_http",
    manual_document: "manual_json",
    explicit_ingest: "ingest_command"
  };
  const switches = { on: '{"version":1,"enabled":true}', off: '{"version":1,"enabled":false}', invalid: '{"version":2,"enabled":true}' };
  const expand = (row: VectorRow): Snapshot => {
    const spec = { ...contract.rowDefaults, ...row };
    const acquisition = spec.meter === "ACQUISITION";
    return {
      provider: spec.provider,
      meter: spec.meter,
      value: spec.value,
      unit: "PERCENT",
      window: acquisition ? { kind: "unknown" } : { kind: "rolling", durationSeconds: spec.meter.startsWith("SEVEN_DAY") ? 604_800 : 18_000 },
      resetAt: acquisition ? null : spec.resetAt,
      source: spec.sourceKind === "remote_api" ? "internal_payload" : spec.sourceKind === "manual_document" ? "manual_entry" : "native_payload",
      precision: "exact",
      observedAt: spec.observedAt,
      expiresAt: new Date(Date.parse(spec.observedAt) + 465_000).toISOString(),
      labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint", automationRisk: "high", verification: "UNVERIFIED" },
      ...(spec.accountId === null ? {} : { accountId: spec.accountId }),
      ...(spec.sourceKind === null ? {} : { provenance: { sourceKind: spec.sourceKind, observedVia: observedVia[spec.sourceKind] } }),
      ...(acquisition ? { kind: "runtime_info" } : {}),
      ...(spec.availability === undefined ? {} : { availability: spec.availability }),
      ...(spec.retryAt === undefined ? {} : { retryAt: spec.retryAt })
    } as Snapshot;
  };
  const key = (row: Snapshot) => [row.provider, row.meter, row.value].join(" ");

  for (const vector of contract.cases) {
    it(vector.id, async () => {
      const directory = await temporaryDirectory();
      const stored = (store: VectorRow["store"]) => vector.rows.filter((row) => row.store === store).map(expand);
      if (stored("main").length > 0 || vector.suppressions !== undefined) {
        await writeFile(path.join(directory, CACHE_FILE_NAME), JSON.stringify({
          version: 3,
          snapshots: stored("main"),
          ...(vector.suppressions === undefined ? {} : { suppressions: vector.suppressions.map((entry) => ({ ...entry, reason: "drift" })) })
        }));
      }
      if (stored("authoritative").length > 0) {
        await writeFile(path.join(directory, AUTHORITATIVE_CACHE_FILE_NAME), JSON.stringify({ version: 3, snapshots: stored("authoritative") }));
      }
      if (vector.switch !== "missing") await writeFile(path.join(directory, "claude-poll.json"), switches[vector.switch]);
      const read = await readSnapshotCache(directory);
      expect(read.ok ? read.snapshots.map(key).sort() : ["unreadable"])
        .toEqual(vector.rows.filter((row) => vector.visible.includes(row.ref)).map((row) => key(expand(row))).sort());
    });
  }
});
