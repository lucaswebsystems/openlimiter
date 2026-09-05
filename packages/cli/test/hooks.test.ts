import { createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { FIXTURE_NOW, codexFixture } from "@openlimiter/connectors";
import {
  AGENT_CONTEXT_FILE_NAME,
  AGENT_CONTEXT_SPILL_FILE_NAME,
  HOSTED_CONTEXT_FILE_NAME,
  agentContextCacheStamp,
  agentContextFromCache,
  hostedTrustFilePath,
  writeAgentContextSnapshot,
  type HostedContextEnvelope,
  type HostedTrustDocument
} from "@openlimiter/adapters";
import { readSnapshotCache, writeSnapshotCache, type Snapshot } from "@openlimiter/core";
import { afterEach, describe, expect, it } from "vitest";
import { persistSnapshots, readStandardInputText, runCli } from "../src/index.js";

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
const HOSTED_FIXTURE_NOW = "2026-09-01T12:05:00.000Z";
const HOSTED_FIXTURE_OWNER_SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(await scratchRoot(), prefix));
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

function meterSnapshot(
  provider: "CODEX" | "CLAUDE",
  observedAt: string
): Snapshot {
  return {
    provider,
    meter: "FIVE_HOUR",
    value: provider === "CODEX" ? 42 : 61,
    unit: "PERCENT",
    window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt: null,
    source: "native_payload",
    precision: "exact",
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 600_000).toISOString(),
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "native-statusline-payload",
      automationRisk: "low",
      verification: "UNVERIFIED"
    }
  };
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

  it("accepts newer releases, rejects older releases, and warns once in hooks status", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-hook-minimum-");
    await runCli(["snapshot", "--refresh"], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      payloads: { codex: codexFixture(FIXTURE_NOW) },
      colorOutput: false
    });
    expect((await runCli([
      "hook", "--agent", "codex", "--host-version", "0.153.0"
    ], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => codexInput()
    })).stdout).toContain("additionalContext");
    expect(await runCli([
      "hook", "--agent", "codex", "--host-version", "0.151.9"
    ], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => codexInput()
    })).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const status = await runCli(["hooks", "status", "claude"], {
      detectedAgentInstallations: {
        claude: {
          version: "2.1.258",
          executable: "C:\\fixture\\claude.exe",
          fileSize: 1,
          mtimeMilliseconds: 1
        }
      }
    });
    expect(status.exitCode).toBe(0);
    expect(status.stdout.split("\n").filter((line) => line.startsWith("warning=")))
      .toEqual(["warning=detected version 2.1.258 is newer than minimum tested 2.1.257"]);
  });

  it("loads hosted trust only from the protected desktop bridge", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-hosted-state-");
    const homeDirectory = await temporaryDirectory("openlimiter-cli-hosted-home-");
    const fixture = JSON.parse(await readFile(
      path.join(
        process.cwd(),
        "packages",
        "adapters",
        "test",
        "fixtures",
        "hosted-context-v1.golden.json"
      ),
      "utf8"
    )) as {
      envelope: HostedContextEnvelope;
      public_key_spki_base64url: string;
      trust_document: HostedTrustDocument;
    };
    await writeFile(
      path.join(stateDirectory, HOSTED_CONTEXT_FILE_NAME),
      JSON.stringify(fixture.envelope),
      "utf8"
    );
    const attackerDirectory = await temporaryDirectory("openlimiter-cli-hosted-override-");
    await writeFile(
      path.join(attackerDirectory, "hosted-trust.json"),
      JSON.stringify(fixture.trust_document),
      "utf8"
    );
    const publicKey = createPublicKey({
      key: Buffer.from(fixture.public_key_spki_base64url, "base64url"),
      format: "der",
      type: "spki"
    });
    const dependencies = {
      stateDirectory,
      homeDirectory,
      /* The host's own layout. A Windows layout under a Unix home is a
         backslash string Unix reads as one file name in the working directory. */
      platform: process.platform,
      now: () => HOSTED_FIXTURE_NOW,
      /* A recorded owner only descriptor, with a fabricated account id. The
         Windows ownership rule itself is proved in the adapters suite. */
      hostedTrustWindowsSecurity: async () => ({
        currentUserSid: HOSTED_FIXTURE_OWNER_SID,
        securityDescriptor: "O:" + HOSTED_FIXTURE_OWNER_SID +
          "G:" + HOSTED_FIXTURE_OWNER_SID +
          "D:PAI(A;;FA;;;" + HOSTED_FIXTURE_OWNER_SID + ")"
      }),
      environment: {
        APPDATA: attackerDirectory,
        OPENLIMITER_HOSTED_TRUST_PATH: path.join(attackerDirectory, "hosted-trust.json")
      },
      hostedContextPublicKeys: { "context-fixture-1": publicKey },
      readStandardInput: async () => codexInput()
    };
    expect(await runCli([
      "hook", "--agent", "codex", "--host-version", "0.152.0"
    ], dependencies)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const trustFile = hostedTrustFilePath(process.platform, homeDirectory);
    await mkdir(path.dirname(trustFile), { recursive: true, mode: 0o700 });
    await writeFile(trustFile, JSON.stringify(fixture.trust_document), {
      encoding: "utf8",
      mode: 0o600
    });
    expect((await runCli([
      "hook", "--agent", "codex", "--host-version", "0.152.0"
    ], dependencies)).stdout).toContain("hosted_status provider=ANTHROPIC");
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

  it("never injects a context older than the cache it came from", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-context-order-");
    const earlier = "2026-09-01T12:00:00.000Z";
    const later = "2026-09-01T12:01:00.000Z";
    const first = await persistSnapshots(
      [meterSnapshot("CODEX", earlier)],
      stateDirectory,
      earlier
    );
    await persistSnapshots(
      [meterSnapshot("CLAUDE", later)],
      stateDirectory,
      later
    );
    /* The first ingestion committed first, so its derived write may still be
       in flight when the second one commits. Landing it last must not put the
       prompt context behind the durable cache. */
    await writeAgentContextSnapshot(first.merged, stateDirectory, earlier);
    const context = await agentContextFromCache(stateDirectory, later);
    expect(context).toContain("provider=CODEX");
    expect(context).toContain("provider=CLAUDE");
    const cached = await readSnapshotCache(stateDirectory);
    const document = JSON.parse(await readFile(
      path.join(stateDirectory, AGENT_CONTEXT_FILE_NAME),
      "utf8"
    )) as { cache_stamp: { digest: string; observed_at: string } };
    expect(cached.ok).toBe(true);
    expect(document.cache_stamp).toEqual({
      digest: agentContextCacheStamp(cached.ok ? cached.snapshots : []).digest,
      observed_at: later
    });
  });

  it("keeps a later wall clock from publishing an older cache stamp", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-context-skew-");
    const older = "2026-09-01T12:00:00.000Z";
    const newer = "2026-09-01T12:05:00.000Z";
    const laterClock = "2026-09-01T12:06:00.000Z";
    await writeSnapshotCache([meterSnapshot("CLAUDE", newer)], stateDirectory);
    await writeAgentContextSnapshot(
      [meterSnapshot("CLAUDE", newer)],
      stateDirectory,
      newer
    );
    /* The cache this writer would have reread is unreadable, so it falls back
       to its own older rows while carrying the later clock of the two. */
    await writeFile(
      path.join(stateDirectory, "openlimiter-cache.json"),
      "{not json",
      "utf8"
    );
    await writeAgentContextSnapshot(
      [meterSnapshot("CODEX", older)],
      stateDirectory,
      laterClock
    );
    const document = JSON.parse(await readFile(
      path.join(stateDirectory, AGENT_CONTEXT_FILE_NAME),
      "utf8"
    )) as { context: string; cache_stamp: { observed_at: string } };
    expect(document.cache_stamp.observed_at).toBe(newer);
    expect(document.context).toContain("provider=CLAUDE");
    expect(document.context).not.toContain("provider=CODEX");
  });

  it("writes nothing through a context read whose deadline has already passed", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-context-abort-");
    await runCli(["snapshot", "--refresh"], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      payloads: { codex: codexFixture(FIXTURE_NOW) },
      colorOutput: false
    });
    const spillFile = path.join(stateDirectory, AGENT_CONTEXT_SPILL_FILE_NAME);
    await writeFile(spillFile, "sentinel", "utf8");
    const deadline = new AbortController();
    deadline.abort();
    expect(await agentContextFromCache(stateDirectory, FIXTURE_NOW, undefined, {
      signal: deadline.signal
    })).toBe("");
    expect(await readFile(spillFile, "utf8")).toBe("sentinel");
  });

  it("lets the next context writer run after one turn fails", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-context-turn-");
    const now = "2026-09-01T12:00:00.000Z";
    const snapshots = [meterSnapshot("CODEX", now)];
    await writeSnapshotCache(snapshots, stateDirectory);
    const blocker = path.join(stateDirectory, AGENT_CONTEXT_FILE_NAME);
    await mkdir(path.join(blocker, "occupied"), { recursive: true });
    /* Both writers are handled in the tick they are created and both are
       awaited before the directory is touched. Which of them wins the turn is
       not fixed, so attaching to one and only then to the other would leave
       the loser's failure unobserved for as long as the first one runs. */
    const settled = await Promise.allSettled([
      writeAgentContextSnapshot(snapshots, stateDirectory, now),
      writeAgentContextSnapshot(snapshots, stateDirectory, now)
    ]);
    expect(settled.map((outcome) => outcome.status)).toEqual([
      "rejected",
      "rejected"
    ]);
    await rm(blocker, { recursive: true, force: true });
    await writeAgentContextSnapshot(snapshots, stateDirectory, now);
    expect(await readFile(blocker, "utf8")).toContain("provider=CODEX");
  });

  it("writes nothing once a read resolves after the hard deadline", async () => {
    const stateDirectory = await temporaryDirectory("openlimiter-cli-hook-late-");
    await runCli(["snapshot", "--refresh"], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      payloads: { codex: codexFixture(FIXTURE_NOW) },
      colorOutput: false
    });
    const spillFile = path.join(stateDirectory, AGENT_CONTEXT_SPILL_FILE_NAME);
    await writeFile(spillFile, "sentinel", "utf8");
    const start = performance.now();
    const result = await runCli([
      "hook", "--agent", "codex", "--host-version", "0.152.0"
    ], {
      stateDirectory,
      now: () => FIXTURE_NOW,
      readStandardInput: async () => await new Promise<string>((resolve) => {
        setTimeout(() => resolve(codexInput()), 700);
      })
    });
    expect(performance.now() - start).toBeLessThan(550);
    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
    expect(await readFile(spillFile, "utf8")).toBe("sentinel");
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
