import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "@openlimiter/connectors";
import {
  ACQUISITION_STATE_FILE_NAME,
  CACHE_FILE_NAME,
  OPENLIMITER_USER_AGENT,
  REFRESH_LOCK_NAME,
  acquireRefreshLock,
  readSnapshotCache,
  writeSnapshotCache,
  type AcquisitionRequest,
  type AcquisitionTransport,
  type Snapshot
} from "@openlimiter/core";
import { runCli, runtimeDependencies } from "../src/index.js";
import {
  SYNTHETIC_CODEX_ACCOUNT,
  SYNTHETIC_GROK_USER,
  SYNTHETIC_PROJECT,
  SYNTHETIC_TOKEN,
  codexCountdownResponse,
  credentialDocuments,
  recordedResponses
} from "./fixtures/acquisition.js";

const NOW = FIXTURE_NOW;

let canonicalTemp: string | undefined;
async function scratchRoot(): Promise<string> {
  canonicalTemp ??= await realpath(tmpdir());
  return canonicalTemp;
}

const created: string[] = [];

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

/** A home directory holding exactly what each vendor's own client would write. */
async function machineWithLogins(): Promise<string> {
  const home = await temporaryDirectory("openlimiter-home-");
  const files: readonly [readonly string[], unknown][] = [
    [[".claude", ".credentials.json"], credentialDocuments.claude],
    [[".codex", "auth.json"], credentialDocuments.codex],
    [[".gemini", "oauth_creds.json"], credentialDocuments.gemini],
    [[".grok", "auth.json"], credentialDocuments.grok],
    [[".kimi", "credentials", "kimi-code.json"], credentialDocuments.kimi]
  ];
  for (const [segments, document] of files) {
    const file = path.join(home, ...segments);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(document), "utf8");
  }
  return home;
}

interface Recorder {
  readonly transport: AcquisitionTransport;
  readonly sent: AcquisitionRequest[];
}

function recordingTransport(
  now = NOW,
  overrides: Readonly<Record<string, unknown>> = {}
): Recorder {
  const responses = { ...recordedResponses(now), ...overrides };
  const sent: AcquisitionRequest[] = [];
  return {
    sent,
    transport: async (request) => {
      sent.push(request);
      const body = responses[request.endpoint];
      return body === undefined
        ? { status: 404, body: "", retryAfterSeconds: null }
        : { status: 200, body: JSON.stringify(body), retryAfterSeconds: null };
    }
  };
}

function dependencies(
  stateDirectory: string,
  home: string,
  transport: AcquisitionTransport,
  now = NOW
): Parameters<typeof runCli>[1] {
  return {
    stateDirectory,
    homeDirectory: home,
    platform: "linux",
    environment: { OPENLIMITER_OPENROUTER_KEY: SYNTHETIC_TOKEN },
    now: () => now,
    colorOutput: false,
    acquisitionTransport: transport
  };
}

async function cachedProviders(directory: string): Promise<string[]> {
  const cached = await readSnapshotCache(directory);
  return cached.ok
    ? [...new Set(cached.snapshots.map((snapshot) => snapshot.provider))].sort()
    : [];
}

describe("openlimiter refresh", () => {
  it("acquires every provider this machine has a login for", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const recorder = recordingTransport();
    const result = await runCli(
      ["refresh"],
      dependencies(state, home, recorder.transport)
    );
    expect(result.exitCode).toBe(0);
    /* Claude is absent from the cache on purpose: its poll is off until a
       person turns it on, and the status line payload is its source. */
    expect(await cachedProviders(state)).toEqual([
      "ANTIGRAVITY",
      "CODEX",
      "GEMINI_CLI",
      "GROK",
      "KIMI",
      "OPENROUTER"
    ]);
    expect(result.stdout).toContain("codex yes read");
    expect(result.stdout).toContain("claude no off");
    /*
     * Antigravity here is the Gemini CLI's login borrowed for the shared Code
     * Assist pool, because this machine profile has no Antigravity credential
     * store. The row says whose login it actually is.
     */
    expect(result.stdout).toContain("antigravity/gemini-cli-shared yes read");
    expect(result.stdout).toContain("not");
  });

  it("identifies itself as OpenLimiter and never as a vendor's client", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const recorder = recordingTransport();
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    expect(recorder.sent.length).toBeGreaterThan(0);
    for (const request of recorder.sent) {
      expect(request.headers["user-agent"]).toBe(OPENLIMITER_USER_AGENT);
      expect(request.headers["authorization"]).toBe("Bearer " + SYNTHETIC_TOKEN);
    }
    const codex = recorder.sent.find((request) => request.endpoint === "codex_usage");
    expect(codex?.headers["chatgpt-account-id"]).toBe(SYNTHETIC_CODEX_ACCOUNT);
    const grok = recorder.sent.find((request) => request.endpoint === "grok_billing");
    expect(grok?.headers["x-userid"]).toBe(SYNTHETIC_GROK_USER);
    /* No vendor client marker anywhere. xAI's own tool sends
       x-xai-token-auth: xai-grok-cli, and sending it would be claiming to be
       that tool. */
    expect(Object.keys(grok?.headers ?? {})).not.toContain("x-xai-token-auth");
    expect(JSON.stringify(recorder.sent)).not.toContain("grok-cli");
    const quota = recorder.sent.find(
      (request) => request.endpoint === "code_assist_quota"
    );
    expect(quota?.body).toContain(SYNTHETIC_PROJECT);
  });

  it("keeps every token out of its own output and off the disk", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const recorder = recordingTransport();
    const result = await runCli(
      ["refresh"],
      dependencies(state, home, recorder.transport)
    );
    expect(result.stdout).not.toContain(SYNTHETIC_TOKEN);
    expect(result.stderr).not.toContain(SYNTHETIC_TOKEN);
    for (const file of [CACHE_FILE_NAME, ACQUISITION_STATE_FILE_NAME]) {
      const stored = await readFile(path.join(state, file), "utf8");
      expect(stored).not.toContain(SYNTHETIC_TOKEN);
    }
  });

  it("marks its own rows so a second refresher can tell whose they are", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["refresh"], dependencies(state, home, recordingTransport().transport));
    const cached = await readSnapshotCache(state);
    expect(cached.ok).toBe(true);
    const rows = cached.ok ? cached.snapshots : [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.writer).toBe("cli");
      expect(row.provenance).toEqual({
        sourceKind: "remote_api",
        observedVia: "remote_http"
      });
    }
  });

  it("asks each provider at most once every fifteen minutes", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const first = recordingTransport();
    await runCli(["refresh"], dependencies(state, home, first.transport));
    const asked = first.sent.length;
    expect(asked).toBeGreaterThan(0);

    const second = recordingTransport();
    const soon = await runCli(
      ["refresh"],
      dependencies(state, home, second.transport, "2026-01-01T00:10:00.000Z")
    );
    expect(second.sent).toHaveLength(0);
    expect(soon.stdout).toContain("waiting");

    const third = recordingTransport("2026-01-01T00:20:00.000Z");
    await runCli(
      ["refresh"],
      dependencies(state, home, third.transport, "2026-01-01T00:20:00.000Z")
    );
    expect(third.sent.length).toBe(asked);
  });

  it("waits an hour after a rate limit and a day after a refusal", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const rateLimited: AcquisitionTransport = async (request) =>
      request.endpoint === "kimi_usage"
        ? { status: 429, body: "", retryAfterSeconds: null }
        : { status: 403, body: "", retryAfterSeconds: null };
    const result = await runCli(
      ["refresh"],
      dependencies(state, home, rateLimited)
    );
    expect(result.stdout).toContain("kimi yes stale 2026-01-01T01:00:00.000Z");
    expect(result.stdout).toContain("codex yes stale 2026-01-02T00:00:00.000Z");
    /* A failed read never rewrites the cache. The rows a person already had
       stay, and age out through the ordinary freshness rule. */
    expect(await cachedProviders(state)).toEqual([]);
  });

  it("stands down while the desktop app is refreshing this cache", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const desktopRow: Snapshot = {
      provider: "CODEX",
      meter: "FIVE_HOUR",
      value: 12,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: 18_000 },
      resetAt: null,
      source: "internal_payload",
      precision: "estimated",
      observedAt: NOW,
      expiresAt: "2026-01-01T00:01:00.000Z",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "internal-endpoint",
        automationRisk: "high",
        verification: "UNVERIFIED"
      },
      writer: "desktop"
    };
    await writeSnapshotCache([desktopRow], state);
    const recorder = recordingTransport();
    const result = await runCli(
      ["refresh"],
      dependencies(state, home, recorder.transport)
    );
    expect(recorder.sent).toHaveLength(0);
    expect(result.stdout).toContain("SKIPPED the desktop app");
  });

  it("keeps a desktop row that appeared between its read and its write", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const recorder = recordingTransport();
    /*
     * The desktop writes a Codex row a minute newer than this round's clock,
     * with no writer marker, which is exactly what the shipped desktop does
     * today. The round must not overwrite it with an older reading.
     */
    const desktopRow: Snapshot = {
      provider: "CODEX",
      meter: "FIVE_HOUR",
      value: 7,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: 18_000 },
      resetAt: null,
      source: "internal_payload",
      precision: "estimated",
      observedAt: "2026-01-01T00:01:00.000Z",
      expiresAt: "2026-01-01T09:00:00.000Z",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "internal-endpoint",
        automationRisk: "high",
        verification: "UNVERIFIED"
      }
    };
    await writeSnapshotCache([desktopRow], state);
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    const cached = await readSnapshotCache(state);
    const codex = (cached.ok ? cached.snapshots : []).filter(
      (snapshot) => snapshot.provider === "CODEX" && snapshot.meter === "FIVE_HOUR"
    );
    expect(codex).toHaveLength(1);
    expect(codex[0]?.value).toBe(7);
    expect(codex[0]?.observedAt).toBe("2026-01-01T00:01:00.000Z");
    /* The rest of the round still landed. */
    expect(await cachedProviders(state)).toContain("KIMI");
  });

  it("labels the borrowed Gemini login for a surface to print", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["refresh"], dependencies(state, home, recordingTransport().transport));
    const cached = await readSnapshotCache(state);
    const shared = (cached.ok ? cached.snapshots : []).filter(
      (snapshot) => snapshot.provider === "ANTIGRAVITY"
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const snapshot of shared) {
      expect(snapshot.accountId).toBe("gemini-cli-shared");
      expect(snapshot.accountLabel).toBe("Shared Google Code Assist quota");
    }
  });

  it("stands down while another refresh already holds the lock", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const held = await acquireRefreshLock(state);
    expect(held.ok).toBe(true);
    const recorder = recordingTransport();
    const result = await runCli(
      ["refresh"],
      dependencies(state, home, recorder.transport)
    );
    expect(recorder.sent).toHaveLength(0);
    expect(result.stdout).toContain("SKIPPED another refresh");
    if (held.ok) await held.release();
  });

  it("releases the lock it took, so the next refresh can run", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["refresh"], dependencies(state, home, recordingTransport().transport));
    await expect(readFile(path.join(state, REFRESH_LOCK_NAME), "utf8"))
      .rejects.toThrow();
  });

  it("reads a Codex window that states a countdown instead of an instant", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const recorder = recordingTransport(NOW, {
      codex_usage: codexCountdownResponse()
    });
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    const cached = await readSnapshotCache(state);
    const codex = cached.ok
      ? cached.snapshots.filter((snapshot) => snapshot.provider === "CODEX")
      : [];
    expect(codex.map((snapshot) => snapshot.meter).sort()).toEqual([
      "FIVE_HOUR",
      "SEVEN_DAY"
    ]);
    expect(codex.find((snapshot) => snapshot.meter === "FIVE_HOUR")?.resetAt)
      .toBe("2026-01-01T01:00:00.000Z");
  });
});

describe("the Claude poll switch", () => {
  it("is off by default and says so on the row", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const value = await runCli(
      ["config", "get", "providers.claude.poll"],
      dependencies(state, home, recordingTransport().transport)
    );
    expect(value.stdout).toBe("providers.claude.poll=false");
    const recorder = recordingTransport();
    const result = await runCli(
      ["refresh"],
      dependencies(state, home, recorder.transport)
    );
    expect(
      recorder.sent.some((request) => request.endpoint === "claude_usage")
    ).toBe(false);
    expect(result.stdout).toContain("the Anthropic poll is off");
  });

  it("reads every window the account exposes once it is turned on", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const setting = await runCli(
      ["config", "set", "providers.claude.poll", "true"],
      dependencies(state, home, recordingTransport().transport)
    );
    expect(setting.stdout).toBe("providers.claude.poll=true");
    const recorder = recordingTransport();
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    const cached = await readSnapshotCache(state);
    const claude = cached.ok
      ? cached.snapshots.filter((snapshot) => snapshot.provider === "CLAUDE")
      : [];
    expect(claude.map((snapshot) => snapshot.meter).sort()).toEqual([
      "FIVE_HOUR",
      "SEVEN_DAY",
      "SEVEN_DAY_FABLE"
    ]);
    const usage = recorder.sent.find(
      (request) => request.endpoint === "claude_usage"
    );
    expect(usage?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("refuses a value that is not a switch", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const result = await runCli(
      ["config", "set", "providers.claude.poll", "sometimes"],
      dependencies(state, home, recordingTransport().transport)
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("must be true or false");
  });
});

describe("what the executable actually wires up", () => {
  it("carries a transport, a spawner and a credential helper", () => {
    const runtime = runtimeDependencies();
    /*
     * The wrapped status line, which is what the installer writes for anyone
     * who already had one, used to get only a standard input reader. It
     * rendered bars forever and never started a refresh, so the one path most
     * people end up on was the one path that never acquired anything.
     */
    expect(runtime.acquisitionTransport).toBeTypeOf("function");
    expect(runtime.spawnDetached).toBeTypeOf("function");
    expect(runtime.windowsCredentialRunner).toBeTypeOf("function");
  });

  it("swallows a child that cannot start, rather than taking the host down", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const runtime = runtimeDependencies();
    await runCli(["refresh"], dependencies(state, home, recordingTransport().transport));
    const result = await runCli(["statusline"], {
      ...dependencies(state, home, recordingTransport().transport, "2026-01-01T00:05:00.000Z"),
      spawnDetached: runtime.spawnDetached,
      nodeExecutable: path.join(state, "no-such-executable"),
      openLimiterScript: path.join(state, "no-such-script.js")
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    /* The error arrives after the render returned, so the fact is written down
       and doctor reads it back rather than being lost. */
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    const doctor = await runCli(
      ["doctor"],
      dependencies(state, home, recordingTransport().transport)
    );
    expect(doctor.stdout).toContain("REFRESH SPAWN FAILED");
  });
});

describe("starting a refresh from a render", () => {
  it("starts one when the cache is stale and none when it is fresh", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["refresh"], dependencies(state, home, recordingTransport().transport));
    const started: string[][] = [];
    const spawnDetached = (
      executable: string,
      argumentsList: readonly string[]
    ): void => {
      started.push([executable, ...argumentsList]);
    };

    const fresh = await runCli(["statusline"], {
      ...dependencies(state, home, recordingTransport().transport),
      spawnDetached,
      nodeExecutable: "/usr/bin/node",
      openLimiterScript: "/opt/openlimiter/bin.js"
    });
    expect(fresh.exitCode).toBe(0);
    expect(started).toHaveLength(0);

    const stale = await runCli(["statusline"], {
      ...dependencies(state, home, recordingTransport().transport, "2026-01-01T00:05:00.000Z"),
      spawnDetached,
      nodeExecutable: "/usr/bin/node",
      openLimiterScript: "/opt/openlimiter/bin.js"
    });
    expect(stale.exitCode).toBe(0);
    expect(started).toEqual([
      ["/usr/bin/node", "/opt/openlimiter/bin.js", "refresh", "--detached"]
    ]);
    /* The render returned its bars. It never waited for the child, and a child
       that could not start would not have changed that. */
    expect(stale.stdout.length).toBeGreaterThan(0);
  });

  it("starts one from snapshot --refresh and never fails the command", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    let started = 0;
    const result = await runCli(["snapshot", "--refresh"], {
      ...dependencies(state, home, recordingTransport().transport),
      spawnDetached: () => {
        started += 1;
        throw new Error("no process for you");
      },
      nodeExecutable: "/usr/bin/node",
      openLimiterScript: "/opt/openlimiter/bin.js"
    });
    expect(started).toBe(1);
    expect(result.exitCode).not.toBe(1);
  });
});

describe("doctor", () => {
  it("keeps the two tables from answering different questions with one word", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const result = await runCli(
      ["doctor"],
      dependencies(state, home, recordingTransport().transport)
    );
    /*
     * The connector table asks whether a payload was pushed into this process.
     * The acquisition table asks whether a login exists on this machine. They
     * answered differently for codex under the same word DETECTED, which read
     * as a contradiction rather than as two questions.
     */
    expect(result.stdout).toContain("CONNECTOR PAYLOAD FRESHNESS DRIFT");
    expect(result.stdout).toContain("PROVIDER DETECTED STATUS NEXT NOTE");
    expect(result.stdout).toContain("codex no unknown UNVERIFIED");
    expect(result.stdout).toContain("codex yes stale");
  });

  it("says what acquisition knows about every provider", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const before = await runCli(
      ["doctor"],
      dependencies(state, home, recordingTransport().transport)
    );
    expect(before.stdout).toContain("PROVIDER DETECTED STATUS NEXT NOTE");
    expect(before.stdout).toContain("codex yes stale");
    expect(before.stdout).toContain("claude no off");

    await runCli(["refresh"], dependencies(state, home, recordingTransport().transport));
    const after = await runCli(
      ["doctor"],
      dependencies(state, home, recordingTransport().transport)
    );
    expect(after.stdout).toContain("codex yes waiting 2026-01-01T00:15:00.000Z");
    expect(after.stdout).not.toContain(SYNTHETIC_TOKEN);
  });

  it("reports a provider with no local login as one that is not set up here", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const bare = await temporaryDirectory("openlimiter-bare-");
    const result = await runCli(["doctor"], {
      stateDirectory: state,
      homeDirectory: bare,
      platform: "linux",
      environment: {},
      now: () => NOW,
      colorOutput: false,
      acquisitionTransport: recordingTransport().transport
    });
    expect(result.stdout).toContain("codex no not_detected");
    expect(result.stdout).toContain("openrouter no not_detected");
  });
});
