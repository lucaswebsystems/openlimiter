import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { FIXTURE_NOW, codexFixture } from "@openlimiter/connectors";
import { afterEach, describe, expect, it } from "vitest";
import { readStandardInputText, runCli } from "../src/index.js";

const created: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of created.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function codexInput(): string {
  return JSON.stringify({
    session_id: "session",
    transcript_path: "C:\\tmp\\transcript.jsonl",
    cwd: "C:\\work",
    permission_mode: "default",
    hook_event_name: "UserPromptSubmit",
    model: "gpt-5.6-sol",
    turn_id: "turn",
    prompt: "pong"
  });
}

describe("hook CLI", () => {
  it("installs and uninstalls a tested Codex hook without replacing existing hooks", async () => {
    const homeDirectory = await temporaryDirectory("openlimiter-cli-hooks-home-");
    const runtime = path.join(homeDirectory, "runtime with spaces");
    const configFile = path.join(homeDirectory, ".codex", "hooks.json");
    await mkdir(runtime, { recursive: true });
    await mkdir(path.dirname(configFile), { recursive: true });
    const nodeExecutable = path.join(runtime, "node.exe");
    const openLimiterScript = path.join(runtime, "openlimiter cli.js");
    await writeFile(nodeExecutable, "fixture", "utf8");
    await writeFile(openLimiterScript, "fixture", "utf8");
    const agentStat = await stat(nodeExecutable);
    await writeFile(configFile, JSON.stringify({
      description: "keep this Codex hook description",
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "existing" }] }]
      }
    }), "utf8");
    const dependencies = {
      homeDirectory,
      nodeExecutable,
      openLimiterScript,
      platform: "win32" as const,
      environment: {},
      detectedAgentInstallations: {
        codex: {
          version: "0.152.0",
          executable: nodeExecutable,
          fileSize: agentStat.size,
          mtimeMilliseconds: agentStat.mtimeMs
        }
      }
    };
    expect(await runCli(["hooks", "install", "codex"], dependencies)).toMatchObject({
      exitCode: 0
    });
    expect((await runCli(["hooks", "install", "codex"], dependencies)).stdout)
      .toContain("changed=no");
    const installed = JSON.parse(await readFile(configFile, "utf8")) as {
      description: string;
      hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] };
    };
    expect(installed.description).toBe("keep this Codex hook description");
    expect(installed.hooks.UserPromptSubmit).toHaveLength(2);
    expect(installed.hooks.UserPromptSubmit[1]!.hooks[0]!.command)
      .toContain("--managed-hook openlimiter-v1");
    expect(await readFile(configFile + ".openlimiter.bak", "utf8"))
      .toContain("keep this Codex hook description");
    await writeFile(nodeExecutable, "fixture updated", "utf8");
    const updatedAgentStat = await stat(nodeExecutable);
    const repairedDependencies = {
      ...dependencies,
      detectedAgentInstallations: {
        codex: {
          version: "0.152.0",
          executable: nodeExecutable,
          fileSize: updatedAgentStat.size,
          mtimeMilliseconds: updatedAgentStat.mtimeMs
        }
      }
    };
    expect((await runCli(["hooks", "repair", "codex"], repairedDependencies)).stdout)
      .toContain("changed=yes");
    expect(await runCli(["hooks", "uninstall", "codex"], repairedDependencies)).toMatchObject({
      exitCode: 0
    });
    expect((await runCli(["hooks", "uninstall", "codex"], repairedDependencies)).stdout)
      .toContain("changed=no");
    const removed = await readFile(configFile, "utf8");
    expect(removed).toContain("existing");
    expect(removed).not.toContain("openlimiter-v1");
  });

  it("emits the exact Codex protocol from the shared snapshot", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-hook-state-");
    await runCli(["snapshot", "--refresh"], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      payloads: { codex: codexFixture(FIXTURE_NOW) },
      colorOutput: false
    });
    const result = await runCli([
      "hook", "--agent", "codex", "--host-version", "0.152.0"
    ], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => codexInput()
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(output.hookSpecificOutput.additionalContext)
      .toContain('<openlimiter_untrusted_data version="1">');
  });

  it("is silent for a missing snapshot and for an unknown host version", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-hook-empty-");
    for (const version of ["0.152.0", "999.0.0"]) {
      const result = await runCli([
        "hook", "--agent", "codex", "--host-version", version
      ], {
        stateDirectory,
        now: () => FIXTURE_NOW,
        readStandardInput: async () => codexInput()
      });
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }
  });

  it("rejects invalid UTF 8 before parsing hook input", async () => {
    const stream = new PassThrough();
    stream.end(Buffer.from([0x7b, 0x22, 0xc3, 0x22, 0x7d]));
    await expect(readStandardInputText(
      stream as unknown as NodeJS.ReadStream,
      65_536,
      50
    )).resolves.toBeNull();
  });

  it("rejects a managed hook after the pinned agent executable changes", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-hook-stamp-state-");
    const runtime = await temporaryDirectory("openlimiter-cli-hook-stamp-runtime-");
    const executable = path.join(runtime, "codex.exe");
    await writeFile(executable, "first", "utf8");
    const stamp = await stat(executable);
    await runCli(["snapshot", "--refresh"], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      payloads: { codex: codexFixture(FIXTURE_NOW) },
      colorOutput: false
    });
    const argumentsList = [
      "hook", "--agent", "codex", "--host-version", "0.152.0",
      "--agent-executable", executable,
      "--agent-file-size", String(stamp.size),
      "--agent-mtime-ms", String(stamp.mtimeMs),
      "--managed-hook", "openlimiter-v1"
    ];
    const before = await runCli(argumentsList, {
      stateDirectory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => codexInput()
    });
    expect(before.stdout).toContain("additionalContext");
    await writeFile(executable, "second version", "utf8");
    expect(await runCli(argumentsList, {
      stateDirectory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => codexInput()
    })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  it("keeps the experimental OpenCode protocol behind its runtime kill switch", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-opencode-state-");
    await runCli(["snapshot", "--refresh"], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      payloads: { codex: codexFixture(FIXTURE_NOW) },
      colorOutput: false
    });
    const rawInput = JSON.stringify({
      hook_event_name: "OpenCodeSystemTransform",
      session_id: "session",
      cwd: "C:\\work"
    });
    const command = [
      "hook", "--agent", "opencode", "--host-version", "1.18.11"
    ];
    expect(await runCli(command, {
      stateDirectory,
      now: () => FIXTURE_NOW,
      environment: {},
      readStandardInput: async () => rawInput
    })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect((await runCli(command, {
      stateDirectory,
      now: () => FIXTURE_NOW,
      environment: { OPENLIMITER_EXPERIMENTAL_OPENCODE: "1" },
      readStandardInput: async () => rawInput
    })).stdout).toContain("openlimiter_untrusted_data");
  });

  it("returns a successful empty response before the hard deadline for every adapter", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-hook-timeout-");
    for (const agent of [
      "claude", "codex", "gemini", "antigravity", "kimi", "opencode"
    ] as const) {
      const start = performance.now();
      const result = await runCli([
        "hook", "--agent", agent, "--host-version", "fixture"
      ], {
        stateDirectory,
        now: () => FIXTURE_NOW,
        readStandardInput: async () => await new Promise<string | null>(() => undefined)
      });
      expect(performance.now() - start).toBeLessThan(550);
      expect(result).toEqual({
        exitCode: 0,
        stdout: agent === "gemini" || agent === "antigravity" ? "{}" : "",
        stderr: ""
      });
    }
  });

  it("keeps an internal failure from becoming a nonzero agent exit for every adapter", async () => {
    for (const agent of [
      "claude", "codex", "gemini", "antigravity", "kimi", "opencode"
    ] as const) {
      const result = await runCli([
        "hook", "--agent", agent, "--host-version", "fixture"
      ], {
        now: () => FIXTURE_NOW,
        readStandardInput: async () => {
          throw new Error("fixture failure");
        }
      });
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }
  });

  it("exposes agent context only through the explicit status command", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-status-state-");
    expect(await runCli(["status", "--agent-context"], {
      stateDirectory,
      now: () => FIXTURE_NOW
    })).toMatchObject({ exitCode: 3, stdout: "" });
    await runCli(["snapshot", "--refresh"], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      payloads: { codex: codexFixture(FIXTURE_NOW) }
    });
    const status = await runCli(["status", "--agent-context"], {
      stateDirectory,
      now: () => FIXTURE_NOW
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("provider=CODEX");
  });
});
