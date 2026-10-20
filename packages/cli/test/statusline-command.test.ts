import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORITATIVE_CACHE_FILE_NAME, CACHE_FILE_NAME, mergeAuthoritativeSnapshotCache, normalizeMeters, opaqueAccountId,
  recordAcquisitionAvailability
} from "@openlimiter/core";
import { parseClaudePayload } from "@openlimiter/connectors";
import { AGENT_CONTEXT_FILE_NAME } from "@openlimiter/adapters";
import { runCli } from "../src/cli.js";
import { persistSnapshots } from "../src/ingest.js";

const NOW = "2026-01-01T00:00:00.000Z";
const payload = (directory = "/work/Olá projeto") => ({
  model: { display_name: "Claude Opus 5.5 (long context)", id: "fallback" },
  effort: { level: "high" },
  workspace: { current_dir: directory },
  context_window: { used_percentage: 42 },
  output_style: { name: "concise" },
  rate_limits: {
    five_hour: { used_percentage: 17, resets_at: Date.parse("2026-01-01T03:20:00Z") / 1000 },
    seven_day: { used_percentage: 65, resets_at: "2026-01-05T02:00:00Z" }
  }
});
const plain = "opus-5-5 high | ctx 42% | 5h [█░░░░░░░░░] 17% ·3h20m | 7d [██████░░░░] 65% ·4d2h | cx7d [████████░░] 85% ·4d2h | concise";
const painted = "opus-5-5 high | ctx 42% | 5h \x1b[32m[█░░░░░░░░░]\x1b[0m \x1b[32m17%\x1b[0m ·3h20m | 7d \x1b[33m[██████░░░░]\x1b[0m \x1b[33m65%\x1b[0m ·4d2h | cx7d \x1b[38;5;208m[████████░░]\x1b[0m \x1b[38;5;208m85%\x1b[0m ·4d2h | concise";

const roots: string[] = [];
async function seeded(): Promise<string> {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "openlimiter-statusline-command-"));
  roots.push(directory);
  const rows = normalizeMeters(parseClaudePayload(payload(), NOW)!);
  const pollRows = normalizeMeters(parseClaudePayload({
    five_hour: { used_percentage: 17, resets_at: Date.parse("2026-01-01T03:20:00Z") / 1000 },
    seven_day: { utilization: 65, resets_at: "2026-01-05T02:00:00Z" }
  }, NOW)!).filter((row) => row.meter.startsWith("SEVEN_DAY"));
  await persistSnapshots([
    // Old host readings must be replaced, while another provider survives.
    ...rows.map((row) => ({ ...row, value: 1 })),
    { ...pollRows[0]!, provider: "CODEX", value: 85 }
  ], directory, NOW);
  await mergeAuthoritativeSnapshotCache(pollRows, directory, NOW);
  return directory;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("statusline command reference layout", () => {
  it.each([
    ["Windows", "C:\\work\\Olá projeto\\"],
    ["macOS", "/Volumes/work/Olá projeto/"],
    ["Linux", "/workspace/Olá projeto"]
  ])("prints exact ANSI and NO_COLOR lines from one stdin read for %s", async (_os, directory) => {
    const stateDirectory = await seeded();
    for (const environment of [{}, { NO_COLOR: "" }]) {
      const readStandardInput = vi.fn(async () => JSON.stringify(payload(directory)));
      const result = await runCli(["statusline", "--host", "claude"], {
        stateDirectory, now: () => NOW, environment, colorOutput: false, readStandardInput
      });
      expect(result).toEqual({ exitCode: 0, stdout: "NO_COLOR" in environment ? plain : painted, stderr: "" });
      expect(readStandardInput).toHaveBeenCalledTimes(1);
      expect(result.stdout.match(/cx7d/g)).toHaveLength(1);
    }
    const cache = await readFile(path.join(stateDirectory, CACHE_FILE_NAME), "utf8");
    expect(cache).not.toContain("Olá projeto");
    expect(cache).not.toContain("Opus");
  });

  it("paints the red band through the real command", async () => {
    const stateDirectory = await seeded();
    const input = payload();
    input.rate_limits.five_hour.used_percentage = 95;
    const result = await runCli(["statusline", "--host", "claude"], {
      stateDirectory, now: () => NOW, environment: {}, colorOutput: false,
      readStandardInput: async () => JSON.stringify(input)
    });
    expect(result.stdout).toBe(painted.replace(
      "\x1b[32m[█░░░░░░░░░]\x1b[0m \x1b[32m17%\x1b[0m",
      "\x1b[31m[█████████░]\x1b[0m \x1b[31m95%\x1b[0m"
    ));
  });

  it("says why the Claude weekly is missing: off on both consents, refused, or waiting", async () => {
    const account = opaqueAccountId("CLAUDE", "refused-fixture");
    const render = async (cliPoll: string, desktopPoll: boolean, refused: boolean) => {
      const stateDirectory = await seeded();
      await rm(path.join(stateDirectory, AUTHORITATIVE_CACHE_FILE_NAME));
      await runCli(["config", "set", "providers.claude.poll", cliPoll], { stateDirectory, now: () => NOW });
      if (desktopPoll) {
        await writeFile(path.join(stateDirectory, "claude-poll.json"), JSON.stringify({ version: 1, enabled: true }));
      }
      if (refused) {
        // What the desktop leaves behind when its poll is refused for an account.
        await recordAcquisitionAvailability("CLAUDE", "expired_credentials", NOW, undefined, stateDirectory, account);
        await writeFile(path.join(stateDirectory, "request-policy.json"), JSON.stringify({ version: 1, providers: { claude: {
          refusal_revisions: { [account]: "a".repeat(64) }, attempts: {}, accounts: { [account]: Date.parse(NOW) + 86_400_000 }
        } } }));
      }
      return (await runCli(["statusline", "--host", "claude"], {
        stateDirectory, now: () => NOW, environment: { NO_COLOR: "" },
        readStandardInput: async () => JSON.stringify(payload())
      })).stdout;
    };
    expect(await render("false", false, false)).toMatch(/ \| 7d off$/u);
    expect(await render("false", false, true)).toMatch(/ \| 7d off$/u);
    expect(await render("true", false, false)).toMatch(/ \| 7d waiting$/u);
    expect(await render("false", true, false)).toMatch(/ \| 7d waiting$/u);
    expect(await render("false", true, true)).toMatch(/ \| 7d refused$/u);
  });

  it("reads a malformed or unreadable desktop policy as no refusal, never as a broken line", async () => {
    const account = opaqueAccountId("CLAUDE", "refused-fixture");
    const policy = (claude: unknown) => JSON.stringify({ version: 1, providers: { claude } });
    const refusal = (deadline: unknown) => policy({ refusal_revisions: { [account]: "a".repeat(64) }, attempts: {}, accounts: { [account]: deadline } });
    for (const document of [
      refusal({ toString: 0 }),
      refusal(String(Date.parse(NOW) + 86_400_000)),
      refusal([Date.parse(NOW) + 86_400_000]),
      policy(5),
      "null",
      "[]",
      "{",
      null // a folder where the file belongs: present but unreadable
    ]) {
      const stateDirectory = await seeded();
      await rm(path.join(stateDirectory, AUTHORITATIVE_CACHE_FILE_NAME));
      await writeFile(path.join(stateDirectory, "claude-poll.json"), JSON.stringify({ version: 1, enabled: true }));
      await recordAcquisitionAvailability("CLAUDE", "expired_credentials", NOW, undefined, stateDirectory, account);
      const file = path.join(stateDirectory, "request-policy.json");
      if (document === null) await mkdir(file);
      else await writeFile(file, document);
      const result = await runCli(["statusline", "--host", "claude"], {
        stateDirectory, now: () => NOW, environment: { NO_COLOR: "" },
        readStandardInput: async () => JSON.stringify(payload())
      });
      expect(result.stdout, String(document)).toMatch(/ \| 7d waiting$/u);
    }
  });

  it("draws a payload's own 37 over an older poll reading of the same account", async () => {
    /* 37 rendered as 4 only for a payload no login on the machine names: an
       unattributed status line row stands aside while a row of a known
       account is unexpired. A payload from a signed in session is the
       account's newest reading and wins. */
    const home = await mkdtemp(path.join(await realpath(tmpdir()), "openlimiter-statusline-home-"));
    roots.push(home);
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "synthetic-account-uuid" } }));
    const stateDirectory = await mkdtemp(path.join(await realpath(tmpdir()), "openlimiter-statusline-command-"));
    roots.push(stateDirectory);
    const [session] = normalizeMeters(parseClaudePayload(payload(), NOW)!);
    await persistSnapshots([{
      ...session!, value: 4, accountId: opaqueAccountId("CLAUDE", "synthetic-account-uuid"), writer: "desktop",
      source: "internal_payload", provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
      observedAt: "2025-12-31T23:55:00.000Z", expiresAt: "2026-01-01T00:14:00.000Z"
    }], stateDirectory, NOW);
    const input = payload();
    input.rate_limits.five_hour.used_percentage = 37;
    const result = await runCli(["statusline", "--host", "claude"], {
      stateDirectory, homeDirectory: home, now: () => NOW, environment: { NO_COLOR: "" },
      readStandardInput: async () => JSON.stringify(input)
    });
    expect(result.stdout).toContain("5h [███░░░░░░░] 37% ·3h20m");
    expect(result.stdout).not.toContain("4%");
  });

  it("keeps saved segments, windows and providers hidden", async () => {
    const stateDirectory = await seeded();
    const options = { stateDirectory, now: () => NOW, environment: { NO_COLOR: "" } };
    expect((await runCli(["terminal", "hide", "dir", "effort", "5h", "codex"], options)).exitCode).toBe(0);
    const result = await runCli(["statusline", "--host", "claude"], {
      ...options, readStandardInput: async () => JSON.stringify(payload())
    });
    expect(result).toEqual({
      exitCode: 0, stderr: "",
      stdout: "opus-5-5 | ctx 42% | 7d [██████░░░░] 65% ·4d2h | concise"
    });
  });

  it("passes explicit encoding limitations to the renderer", async () => {
    const stateDirectory = await seeded();
    const result = await runCli(["statusline", "--host", "claude"], {
      stateDirectory, now: () => NOW, environment: { NO_COLOR: "", LC_ALL: "C" },
      readStandardInput: async () => JSON.stringify(payload())
    });
    expect(result.stdout).toBe(plain.replaceAll("█", "#").replaceAll("░", ".").replaceAll("·", "."));
  });

  it("NO_COLOR wins over the saved always setting", async () => {
    const stateDirectory = await seeded();
    const options = { stateDirectory, now: () => NOW, environment: { NO_COLOR: "" }, colorOutput: true };
    expect((await runCli(["config", "set", "statusline.color", "always"], options)).exitCode).toBe(0);
    expect((await runCli(["statusline", "--host", "claude"], {
      ...options, readStandardInput: async () => JSON.stringify(payload())
    })).stdout).toBe(plain);
  });

  it("retains session metadata when quota readings are absent", async () => {
    const stateDirectory = await seeded();
    const contextPath = path.join(stateDirectory, AGENT_CONTEXT_FILE_NAME);
    await rm(contextPath);
    const { rate_limits: _limits, ...session } = payload();
    const result = await runCli(["statusline", "--host", "claude"], {
      stateDirectory, now: () => NOW, environment: { NO_COLOR: "" },
      readStandardInput: async () => JSON.stringify(session)
    });
    expect(result).toEqual({
      exitCode: 0, stderr: "",
      stdout: plain.replace("17%", "1%")
    });
    const context = await readFile(contextPath, "utf8");
    expect(context).toContain("CODEX");
    expect(context).not.toContain("Olá projeto");
    expect(context).not.toContain("Opus");
  });
});
