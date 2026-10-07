import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW, claudeFixture, grokFixture } from "@openlimiter/connectors";
import { CACHE_FILE_NAME, opaqueAccountId, readSnapshotCache } from "@openlimiter/core";
import { runCli } from "../src/index.js";

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
    const statusline = () => runCli(["statusline", "--host", "claude"], {
      stateDirectory: directory, now: () => FIXTURE_NOW, readStandardInput: async () => JSON.stringify(claudeFixture(FIXTURE_NOW))
    });
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
});
