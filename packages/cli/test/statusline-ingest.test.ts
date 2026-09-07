import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW, claudeFixture, grokFixture } from "@openlimiter/connectors";
import { CACHE_FILE_NAME } from "@openlimiter/core";
import { runCli } from "../src/index.js";

/**
 * Host aware standard input ingestion, against recorded payload shapes.
 *
 * Each fixture below is either the connector package's own recorded shape
 * (Claude, Grok, both already used elsewhere in this repo to exercise the
 * documented API contract) or a scrubbed shape built from the host research
 * this lane recorded (Antigravity's status line payload, `quota` keyed by
 * bucket id, distinct from the loopback probe's `groups[].buckets[]` shape
 * covered in packages/core/test/antigravity-probe.test.ts). Nothing here
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
    model: "gemini-3-pro",
    context_window: 1_000_000,
    plan_tier: "individual",
    quota: {
      "gemini-5h": {
        remaining_fraction: 0.73,
        reset_time: new Date(new Date(now).getTime() + 5 * 3_600_000).toISOString(),
        reset_in_seconds: 18_000
      },
      "gemini-weekly": {
        remaining_fraction: 0.76,
        reset_time: new Date(new Date(now).getTime() + 7 * 86_400_000).toISOString(),
        reset_in_seconds: 604_800
      }
    }
  };
}

describe("statusline ingestion by host", () => {
  it("Claude: rate_limits five_hour and seven_day become cache rows", async () => {
    const directory = await temporaryDirectory();
    const result = await runCli(["statusline", "--host", "claude"], {
      stateDirectory: directory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => JSON.stringify(claudeFixture(FIXTURE_NOW))
    });
    expect(result.exitCode).toBe(0);
    const rows = await cachedRows(directory);
    expect(rows.map((row) => row.meter).sort()).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
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
    expect(rows.map((row) => row.meter).sort()).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
    for (const row of rows) {
      expect(row.provider).toBe("ANTIGRAVITY");
      expect(row.provenance).toEqual({
        sourceKind: "statusline_payload",
        observedVia: "local_command"
      });
    }
    /* Its own window carries no tag when rendered for its own host. */
    expect(result.stdout).toContain("5h");
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
    expect(rows.map((row) => row.meter).sort()).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
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
