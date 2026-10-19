import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW, claudeFixture, grokFixture, parseClaudePayload } from "@openlimiter/connectors";
import { CACHE_FILE_NAME, mergeSnapshotCache, normalizeMeters, opaqueAccountId, readSnapshotCache } from "@openlimiter/core";
import { runCli } from "../src/index.js";
import { CLAUDE_READINGS_LIMIT, keptClaudeReadings } from "../src/ingest.js";

/**
 * Host aware standard input ingestion, against recorded payload shapes.
 *
 * Each fixture below is either the connector package's own recorded shape
 * (Claude, Grok, both already used elsewhere in this repo to exercise the
 * documented API contract) or a scrubbed shape built from the host research
 * this lane recorded (Antigravity's status line payload, `quota` keyed by
 * bucket id). Nothing here
 * opens a socket: every payload arrives as a stubbed standard input reader.
 */

let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), "openlimiter-ingest-"));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface CachedRow {
  provider: string;
  meter: string;
  resetAt?: string;
  accountId?: string;
  observedAt: string;
  expiresAt: string;
  labels: Record<string, string>;
  provenance?: { sourceKind: string; observedVia: string };
}

async function cachedRows(directory: string): Promise<CachedRow[]> {
  const cache = JSON.parse(
    await readFile(path.join(directory, CACHE_FILE_NAME), "utf8")
  ) as { snapshots: CachedRow[] };
  return cache.snapshots;
}

/**
 * Antigravity CLI's status line payload: `quota` keyed by bucket id, each
 * carrying `remaining_fraction`, `reset_time`, `reset_in_seconds` and a
 * `plan_tier` alongside it, per the host research this lane recorded.
 */
function antigravityStatuslinePayload(now: string): Record<string, unknown> {
  return {
    email: "person@example.com",
    model: "gemini-3-pro",
    context_window: 1_000_000,
    plan_tier: "individual",
    quota: {
      "gemini-5h": {
        remaining_fraction: 0.73,
        reset_in_seconds: 18_000
      },
      "gemini-weekly": {
        remaining_fraction: 0.76,
        reset_time: new Date(new Date(now).getTime() + 7 * 86_400_000).toISOString(),
        reset_in_seconds: 604_800
      },
      "unknown-experimental-bucket": {
        remaining_fraction: 0.5,
        reset_in_seconds: 3_600
      }
    }
  };
}

describe("statusline ingestion by host", () => {
  it("captures identity before a delayed payload and keeps simultaneous accounts distinct", async () => {
    const home = await temporaryDirectory();
    const directory = await temporaryDirectory();
    await mkdir(path.join(home, ".claude"));
    await writeFile(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token" } }));
    const select = (id: string) => writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: id } }));
    await select("fixture-a");
    const options = { stateDirectory: directory, homeDirectory: home, environment: {}, platform: "linux" as const, now: () => FIXTURE_NOW };
    await runCli(["statusline", "--host", "claude"], { ...options, readStandardInput: async () => {
      await select("fixture-b");
      return JSON.stringify(claudeFixture(FIXTURE_NOW));
    } });
    let cache = await readSnapshotCache(directory);
    expect(cache.ok && cache.snapshots.every(row => row.accountId === opaqueAccountId("CLAUDE", "fixture-a"))).toBe(true);
    await runCli(["statusline", "--host", "claude"], { ...options, readStandardInput: async () => JSON.stringify(claudeFixture(FIXTURE_NOW)) });
    cache = await readSnapshotCache(directory);
    expect(cache.ok && new Set(cache.snapshots.map(row => row.accountId))).toEqual(new Set([opaqueAccountId("CLAUDE", "fixture-a"), opaqueAccountId("CLAUDE", "fixture-b")]));
  });
  /*
   * Claude Code keeps its account block in `.claude.json`: beside `~/.claude`
   * by default, and INSIDE the directory a session names in CLAUDE_CONFIG_DIR.
   * The file also carries project history, so on a working machine it is far
   * larger than any credential document. Each row must carry the account of
   * the session that emitted it, the same opaque id the desktop computes.
   */
  async function claudeConfig(directory: string, account: string | null, options: { padding?: number; credential?: boolean } = {}): Promise<void> {
    await mkdir(directory, { recursive: true });
    if (options.credential !== false) {
      await writeFile(path.join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-token", expiresAt: 1 } }));
    }
    if (account !== null) {
      await writeFile(path.join(directory, ".claude.json"), JSON.stringify({
        projects: { history: "x".repeat(options.padding ?? 0) },
        oauthAccount: { accountUuid: account }
      }));
    }
  }
  async function claudeRows(home: string, directory: string, environment: Record<string, string>): Promise<(string | undefined)[]> {
    await runCli(["statusline", "--host", "claude"], {
      stateDirectory: directory, homeDirectory: home, environment, platform: "linux", now: () => FIXTURE_NOW,
      readStandardInput: async () => JSON.stringify(claudeFixture(FIXTURE_NOW))
    });
    const cache = await readSnapshotCache(directory);
    return cache.ok ? cache.snapshots.filter(row => row.provider === "CLAUDE").map(row => row.accountId) : [];
  }

  it("Claude: a default config whose account file outgrew the credential bound still names its account", async () => {
    const home = await temporaryDirectory();
    await claudeConfig(path.join(home, ".claude"), null);
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({
      projects: { history: "x".repeat(2 * 1_048_576) },
      oauthAccount: { accountUuid: "fixture-a" }
    }));
    expect(await claudeRows(home, await temporaryDirectory(), {})).toEqual([
      opaqueAccountId("CLAUDE", "fixture-a")
    ]);
  });

  it("Claude: accounts A and B in two sessions, each with its own CLAUDE_CONFIG_DIR, stay apart", async () => {
    const home = await temporaryDirectory();
    const directory = await temporaryDirectory();
    await claudeConfig(path.join(home, "work-a"), "fixture-a", { padding: 200_000 });
    await claudeConfig(path.join(home, "work-b"), "fixture-b");
    expect(await claudeRows(home, directory, { CLAUDE_CONFIG_DIR: path.join(home, "work-a") }))
      .toEqual([opaqueAccountId("CLAUDE", "fixture-a")]);
    expect(new Set(await claudeRows(home, directory, { CLAUDE_CONFIG_DIR: path.join(home, "work-b") })))
      .toEqual(new Set([opaqueAccountId("CLAUDE", "fixture-a"), opaqueAccountId("CLAUDE", "fixture-b")]));
  });

  it("Claude: a session's own config decides, never the default login beside it", async () => {
    const home = await temporaryDirectory();
    await claudeConfig(path.join(home, ".claude"), null);
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "fixture-a" } }));
    /* Session B keeps its token in a keychain, so only its account file is on disk. */
    await claudeConfig(path.join(home, "work-b"), "fixture-b", { credential: false });
    expect(await claudeRows(home, await temporaryDirectory(), { CLAUDE_CONFIG_DIR: path.join(home, "work-b") }))
      .toEqual([opaqueAccountId("CLAUDE", "fixture-b")]);
  });

  it("Claude: missing account metadata leaves the row anonymous rather than borrowing another login", async () => {
    const home = await temporaryDirectory();
    await claudeConfig(path.join(home, ".claude"), null);
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "fixture-a" } }));
    await claudeConfig(path.join(home, "work-b"), null);
    expect(await claudeRows(home, await temporaryDirectory(), { CLAUDE_CONFIG_DIR: path.join(home, "work-b") }))
      .toEqual([undefined]);
  });

  it("a failed status line write is kept for doctor by stage and code, and cleared by the next success", async () => {
    const directory = await temporaryDirectory();
    /* Each render carries a higher reading: one that proves nothing new is
       not written at all (2.1.6), so it could not clear the record. */
    let percent = 40;
    const statusline = () => {
      const body = claudeFixture(FIXTURE_NOW) as { rate_limits: { five_hour: Record<string, unknown> } };
      body.rate_limits.five_hour["used_percentage"] = ++percent;
      return runCli(["statusline", "--host", "claude"], {
        stateDirectory: directory, now: () => FIXTURE_NOW, readStandardInput: async () => JSON.stringify(body)
      });
    };
    const doctor = async () => (await runCli(["doctor"], { stateDirectory: directory, now: () => FIXTURE_NOW })).stdout;
    /* A directory where the file belongs makes each write fail on its own. */
    const blocker = (name: string) => mkdir(path.join(directory, name, "occupied"), { recursive: true });
    await blocker(CACHE_FILE_NAME);
    expect((await statusline()).exitCode).toBe(0);
    expect(await doctor()).toMatch(/^STATUSLINE WRITE FAILED \S+ cache_write [A-Za-z_]+ /mu);
    await rm(path.join(directory, CACHE_FILE_NAME), { recursive: true, force: true });
    await blocker("openlimiter-agent-context.json");
    await statusline();
    const exported = await doctor();
    expect(exported).toMatch(/^STATUSLINE WRITE FAILED \S+ agent_context [A-Za-z_]+ /mu);
    expect(exported).not.toMatch(/occupied|Users/u);
    /* The agent context writer removes its own temporary file when it fails. */
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    await rm(path.join(directory, "openlimiter-agent-context.json"), { recursive: true, force: true });
    await statusline();
    expect(await doctor()).not.toMatch(/STATUSLINE WRITE FAILED/u);
  });

  it("Claude: the status line imports only the session window", async () => {
    const directory = await temporaryDirectory();
    const result = await runCli(["statusline", "--host", "claude"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => JSON.stringify(claudeFixture(FIXTURE_NOW))
    });
    expect(result.exitCode).toBe(0);
    const rows = await cachedRows(directory);
    expect(rows.map((row) => row.meter).sort()).toEqual(["FIVE_HOUR"]);
    for (const row of rows) {
      expect(row.provider).toBe("CLAUDE");
      expect(row.provenance).toEqual({
        sourceKind: "statusline_payload",
        observedVia: "claude_code_statusline"
      });
    }
  });

  it("Antigravity: quota keyed by bucket id becomes one row per bucket", async () => {
    const directory = await temporaryDirectory();
    const result = await runCli(["statusline", "--host", "antigravity"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => JSON.stringify(antigravityStatuslinePayload(FIXTURE_NOW))
    });
    expect(result.exitCode).toBe(0);
    const rows = await cachedRows(directory);
    // Unknown bucket was dropped; Antigravity keeps both recognized buckets.
    expect(rows.map((row) => row.meter).sort()).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
    const fiveHourRow = rows.find((r) => r.meter === "FIVE_HOUR");
    expect(fiveHourRow).toBeDefined();
    // A reset countdown is display data, never evidence of a rolling window boundary.
    expect(fiveHourRow?.resetAt).toBeNull();
    expect(fiveHourRow?.accountId).toBe(opaqueAccountId("ANTIGRAVITY", "person@example.com"));
    expect(fiveHourRow?.observedAt).toBe(FIXTURE_NOW);
    expect(fiveHourRow?.expiresAt).toBe(new Date(Date.parse(FIXTURE_NOW) + 60_000).toISOString());

    for (const row of rows) {
      expect(row.provider).toBe("ANTIGRAVITY");
      expect(row.provenance).toEqual({
        sourceKind: "statusline_payload",
        observedVia: "antigravity_cli_statusline"
      });
      expect(row.labels).toEqual({
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "native-statusline-payload",
        automationRisk: "low",
        verification: "UNVERIFIED"
      });
    }
    /* Its own window carries no tag when rendered for its own host. */
    expect(result.stdout).toContain("5h");
    expect(result.stdout).toContain("27%");
    expect(result.stdout).toContain("24%");
    expect(result.stdout).not.toContain("ag5h");
  });

  it("Grok: the session JSON shape becomes weekly and on demand rows", async () => {
    const directory = await temporaryDirectory();
    const result = await runCli(["statusline", "--host", "grok"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => JSON.stringify(grokFixture(FIXTURE_NOW))
    });
    expect(result.exitCode).toBe(0);
    const rows = await cachedRows(directory);
    expect(rows.map((row) => row.meter).sort()).toEqual(["ON_DEMAND_MONTHLY", "WEEKLY"]);
    for (const row of rows) {
      expect(row.provider).toBe("GROK");
      expect(row.provenance).toEqual({
        sourceKind: "statusline_payload",
        observedVia: "local_command"
      });
    }
  });

  it("Codex and shell never parse standard input", async () => {
    for (const host of ["codex", "shell"]) {
      const directory = await temporaryDirectory();
      const result = await runCli(["statusline", "--host", host], {
        stateDirectory: directory,
        now: () => FIXTURE_NOW,
        readStandardInput: async () => JSON.stringify(claudeFixture(FIXTURE_NOW))
      });
      expect(result.exitCode).toBe(0);
      await expect(
        readFile(path.join(directory, CACHE_FILE_NAME), "utf8")
      ).rejects.toThrow();
    }
  });

  it("an unrecognised --host falls back to claude rather than failing", async () => {
    const directory = await temporaryDirectory();
    const result = await runCli(["statusline", "--host", "nope"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => JSON.stringify(claudeFixture(FIXTURE_NOW))
    });
    expect(result.exitCode).toBe(0);
    const rows = await cachedRows(directory);
    expect(rows.map((row) => row.meter).sort()).toEqual(["FIVE_HOUR"]);
  });

  it("omitting --host behaves exactly like --host claude, for backward compatibility", async () => {
    const directory = await temporaryDirectory();
    const withFlag = await runCli(["statusline", "--host", "claude"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => JSON.stringify(claudeFixture(FIXTURE_NOW))
    });
    const withoutFlag = await runCli(["statusline"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW
    });
    expect(withoutFlag.stdout).toBe(withFlag.stdout);
  });

  /*
   * Claude Code reruns an idle window's status line on a timer and hands it the
   * rate limits its last API response carried. A rerun is not a new reading:
   * the row keeps the time its reading arrived, so a newer poll is never
   * replaced by an old number stamped with the render's clock (2.1.6, E).
   */
  describe("Claude payload observation time", () => {
    const T1100 = "2026-01-01T11:00:00.000Z";
    const T1130 = "2026-01-01T11:30:00.000Z";
    const T1209 = "2026-01-01T12:09:00.000Z";
    const T1210 = "2026-01-01T12:10:00.000Z";
    const T1211 = "2026-01-01T12:11:00.000Z";
    const T1212 = "2026-01-01T12:12:00.000Z";
    const RESET = "2026-01-01T15:00:00.000Z";
    const account = opaqueAccountId("CLAUDE", "fixture-a");

    async function claudeHome(): Promise<{ home: string; directory: string }> {
      const home = await temporaryDirectory();
      await claudeConfig(path.join(home, ".claude"), "fixture-a");
      await mkdir(path.join(home, ".claude", "projects"));
      return { home, directory: await temporaryDirectory() };
    }

    async function transcriptAt(home: string, session: string, at: string): Promise<string> {
      const file = path.join(home, ".claude", "projects", session + ".jsonl");
      await writeFile(file, "{}\n");
      await utimes(file, new Date(at), new Date(at));
      return file;
    }

    function payload(
      session: string | null,
      transcript: string,
      apiMilliseconds: number,
      percent: number,
      options: { reset?: string; sevenDay?: number } = {}
    ): string {
      return JSON.stringify({
        hook_event_name: "Status",
        ...(session === null ? {} : { session_id: session }),
        transcript_path: transcript,
        cost: { total_api_duration_ms: apiMilliseconds },
        rate_limits: {
          five_hour: { used_percentage: percent, resets_at: Date.parse(options.reset ?? RESET) / 1000 },
          ...(options.sevenDay === undefined ? {} : {
            seven_day: { used_percentage: options.sevenDay, resets_at: Date.parse("2026-01-05T00:00:00.000Z") / 1000 }
          })
        }
      });
    }

    async function seedPoll(directory: string, percent: number, at: string, reset = RESET): Promise<void> {
      const rows = normalizeMeters((parseClaudePayload({ five_hour: { utilization: percent, resets_at: reset } }, at) ?? [])
        .map((row) => ({ ...row, accountId: account, provenance: { sourceKind: "remote_api" as const, observedVia: "remote_http" as const } })));
      await mergeSnapshotCache(rows, directory, Date.parse(at));
    }

    async function fiveHour(directory: string): Promise<{ value: number; observedAt: string } | undefined> {
      const cache = await readSnapshotCache(directory);
      const row = cache.ok ? cache.snapshots.find((item) => item.provider === "CLAUDE" && item.meter === "FIVE_HOUR") : undefined;
      return row === undefined ? undefined : { value: row.value, observedAt: row.observedAt };
    }

    function render(home: string, directory: string, at: string, body: string) {
      return runCli(["statusline", "--host", "claude"], {
        stateDirectory: directory, homeDirectory: home, environment: {}, platform: "linux", now: () => at,
        readStandardInput: async () => body
      });
    }

    it("a timed rerun of an idle window never replaces a newer poll, and a new API response wins", async () => {
      const { home, directory } = await claudeHome();
      const transcript = await transcriptAt(home, "s1", T1100);
      await render(home, directory, T1100, payload("s1", transcript, 1_000, 10));
      expect(await fiveHour(directory)).toEqual({ value: 10, observedAt: T1100 });
      await seedPoll(directory, 80, T1209);
      const idle = await render(home, directory, T1210, payload("s1", transcript, 1_000, 10));
      expect(await fiveHour(directory)).toEqual({ value: 80, observedAt: T1209 });
      expect(idle.stdout).toContain("80%");
      await render(home, directory, T1211, payload("s1", transcript, 2_000, 85));
      expect(await fiveHour(directory)).toEqual({ value: 85, observedAt: T1211 });
    });

    it("a seven_day that appears or disappears changes nothing", async () => {
      const { home, directory } = await claudeHome();
      const transcript = await transcriptAt(home, "s7", T1100);
      await render(home, directory, T1100, payload("s7", transcript, 1_000, 10, { sevenDay: 30 }));
      await seedPoll(directory, 80, T1209);
      await render(home, directory, T1210, payload("s7", transcript, 1_000, 10));
      expect(await fiveHour(directory)).toEqual({ value: 80, observedAt: T1209 });
      await render(home, directory, T1211, payload("s7", transcript, 1_000, 10, { sevenDay: 31 }));
      expect(await fiveHour(directory)).toEqual({ value: 80, observedAt: T1209 });
    });

    it("a reading whose time is uncertain is written only when its content proves it newer", async () => {
      const { home, directory } = await claudeHome();
      await seedPoll(directory, 80, T1209);
      /* A transcript written after the poll (a prompt, not an API response)
         proves nothing: the same window at a lower value stays out. */
      const fresh = await transcriptAt(home, "s8", "2026-01-01T12:09:30.000Z");
      await render(home, directory, T1210, payload("s8", fresh, 1_000, 10));
      expect(await fiveHour(directory)).toEqual({ value: 80, observedAt: T1209 });
      /* Its replay is now a known one, and it still stays out. */
      await render(home, directory, T1211, payload("s8", fresh, 1_000, 10));
      expect(await fiveHour(directory)).toEqual({ value: 80, observedAt: T1209 });
      /* The same window at a higher value is newer, whatever its transcript says. */
      await render(home, directory, T1211, payload("s9", await transcriptAt(home, "s9", T1100), 1_000, 85));
      expect(await fiveHour(directory)).toEqual({ value: 85, observedAt: "2026-01-01T12:09:00.001Z" });
      /* A later window is newer too, even at a lower value. */
      const later = "2026-01-01T17:30:00.000Z";
      await render(home, directory, T1212, payload("s10", path.join(home, "missing.jsonl"), 1_000, 5, { reset: later }));
      expect(await fiveHour(directory)).toEqual({ value: 5, observedAt: T1212 });
      /* An earlier window never is. */
      await render(home, directory, "2026-01-01T12:13:00.000Z", payload("s11", path.join(home, "missing.jsonl"), 1_000, 99));
      expect(await fiveHour(directory)).toEqual({ value: 5, observedAt: T1212 });
    });

    it("no session id and an unreadable log follow the same content rule", async () => {
      const { home, directory } = await claudeHome();
      await seedPoll(directory, 80, T1209);
      const fresh = await transcriptAt(home, "s12", "2026-01-01T12:09:30.000Z");
      await render(home, directory, T1210, payload(null, fresh, 1_000, 10));
      expect(await fiveHour(directory)).toEqual({ value: 80, observedAt: T1209 });
      await writeFile(path.join(directory, "openlimiter-claude-readings.json"), "not json");
      await render(home, directory, T1211, payload("s12", fresh, 1_000, 10));
      expect(await fiveHour(directory)).toEqual({ value: 80, observedAt: T1209 });
      await render(home, directory, T1212, payload(null, fresh, 1_000, 81));
      expect(await fiveHour(directory)).toEqual({ value: 81, observedAt: "2026-01-01T12:09:30.000Z" });
    });

    it("the log drops readings older than six hours and evicts whole sessions, oldest first", () => {
      const now = "2026-01-01T12:00:00.000Z";
      const entry = (session: string, reading: string, observedAt = now) => ({ session, reading, observedAt });
      expect(keptClaudeReadings([entry("a", "1"), entry("b", "2", "2026-01-01T05:59:59.000Z")], now, "a"))
        .toEqual([entry("a", "1")]);
      /* Newest first: c is the newest session, a the oldest, b in between. */
      const many = [entry("c", "1"), ...Array.from({ length: CLAUDE_READINGS_LIMIT }, (_, index) =>
        entry(index % 2 === 0 ? "b" : "a", String(index)))];
      const kept = keptClaudeReadings(many, now, "c");
      expect(kept.length).toBeLessThanOrEqual(CLAUDE_READINGS_LIMIT);
      expect(new Set(kept.map((item) => item.session))).toEqual(new Set(["c", "b"]));
      expect(kept.filter((item) => item.session === "b")).toHaveLength(CLAUDE_READINGS_LIMIT / 2);
      /* One session alone over the cap keeps its newest readings. */
      const alone = Array.from({ length: CLAUDE_READINGS_LIMIT + 5 }, (_, index) => entry("d", String(index)));
      expect(keptClaudeReadings(alone, now, "d")).toEqual(alone.slice(0, CLAUDE_READINGS_LIMIT));
    });

    it("two windows on one session each keep their own reading's time", async () => {
      const { home, directory } = await claudeHome();
      const transcript = await transcriptAt(home, "s5", T1100);
      await render(home, directory, T1100, payload("s5", transcript, 1_000, 10));
      await render(home, directory, T1130, payload("s5", transcript, 500, 20));
      await seedPoll(directory, 80, T1209);
      await render(home, directory, T1210, payload("s5", transcript, 1_000, 10));
      await render(home, directory, T1211, payload("s5", transcript, 500, 20));
      expect(await fiveHour(directory)).toEqual({ value: 80, observedAt: T1209 });
    });

    it("two windows resumed on one session: the older window's first reading never overwrites newer usage", async () => {
      const { home, directory } = await claudeHome();
      const transcript = await transcriptAt(home, "s13", T1100);
      /* Window A shows the session's first reading, then a newer API response. */
      await render(home, directory, T1100, payload("s13", transcript, 1_000, 10));
      await render(home, directory, T1130, payload("s13", transcript, 2_000, 30));
      expect(await fiveHour(directory)).toEqual({ value: 30, observedAt: T1130 });
      /* Window B, resumed on the same session id, hands over its older reading
         for the first time afterwards: neither it nor its reruns replace A's. */
      await render(home, directory, T1210, payload("s13", transcript, 1_500, 20));
      await render(home, directory, T1211, payload("s13", transcript, 1_500, 20));
      expect(await fiveHour(directory)).toEqual({ value: 30, observedAt: T1130 });
      /* A newer API response still wins at once, and one at the same value,
         which changes no number, keeps an active window fresh. */
      await render(home, directory, T1212, payload("s13", transcript, 2_500, 31));
      expect(await fiveHour(directory)).toEqual({ value: 31, observedAt: T1212 });
      const T1213 = "2026-01-01T12:13:00.000Z";
      await render(home, directory, T1213, payload("s13", transcript, 3_000, 31));
      expect(await fiveHour(directory)).toEqual({ value: 31, observedAt: T1213 });
    });

    it("the reading log is bounded, keeps no session id, and is written only when a reading changes", async () => {
      const { home, directory } = await claudeHome();
      const transcript = await transcriptAt(home, "s6", T1100);
      await render(home, directory, T1100, payload("s6", transcript, 1_000, 10));
      const log = (await readdir(directory)).filter((name) => name.includes("claude-readings"));
      expect(log).toHaveLength(1);
      const file = path.join(directory, log[0] ?? "");
      const old = new Date("2025-01-01T00:00:00.000Z");
      await utimes(file, old, old);
      await render(home, directory, T1210, payload("s6", transcript, 1_000, 10));
      expect((await stat(file)).mtimeMs).toBe(old.getTime());
      for (let index = 0; index < 70; index += 1) {
        await render(home, directory, T1211, payload("bulk-" + index, transcript, 1_000, 10));
      }
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("bulk-");
      expect(text).not.toContain("s6");
      expect((JSON.parse(text) as { readings: unknown[] }).readings.length).toBeLessThanOrEqual(CLAUDE_READINGS_LIMIT);
    });
  });
});
