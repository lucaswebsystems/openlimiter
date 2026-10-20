import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_NOW } from "@openlimiter/connectors";
import {
  ACQUISITION_STATE_FILE_NAME,
  opaqueAccountId,
  CACHE_FILE_NAME,
  OPENLIMITER_USER_AGENT,
  REFRESH_LOCK_NAME,
  acquireRefreshLock,
  mergeAuthoritativeSnapshotCache,
  readSnapshotCache,
  writeSnapshotCache,
  type AcquisitionRequest,
  type AcquisitionTransport,
  type Snapshot
} from "@openlimiter/core";
import { runCli, runtimeDependencies } from "../src/index.js";
import { writeSession } from "../src/session.js";
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
    detectedAgentInstallations: {
      codex: {
        version: "0.153.3",
        executable: "synthetic-codex",
        fileSize: 1,
        mtimeMilliseconds: 1
      }
    },
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
  it("discovers Cursor SQLite, dispatches its request and persists normalized rows", async () => {
    const state = await temporaryDirectory("cursor-cli-state-");
    const home = await temporaryDirectory("cursor-cli-home-");
    const file = path.join(home, ".config/Cursor/User/globalStorage/state.vscdb");
    await mkdir(path.dirname(file), { recursive: true });
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)");
      const insert = db.prepare("INSERT INTO ItemTable VALUES (?, ?)");
      insert.run("cursorAuth/accessToken", "synthetic-token");
      insert.run("cursorAuth/stripeMembershipAuthId", "synthetic-auth");
      const fixture = JSON.parse(await readFile(path.resolve("packages/connectors/fixtures/cases/cursor/normal.json"), "utf8")) as { now: string; body: unknown };
      const recorder = recordingTransport(fixture.now, { cursor_usage: fixture.body });
      const result = await runCli(["refresh"], { ...dependencies(state, home, recorder.transport, fixture.now), environment: {} });
      expect(result.exitCode).toBe(0);
      expect(recorder.sent).toHaveLength(1);
      expect(recorder.sent[0]).toMatchObject({ endpoint: "cursor_usage", headers: { cookie: "WorkosCursorSessionToken=synthetic-auth::synthetic-token" } });
      const cache = await readSnapshotCache(state);
      expect(cache.ok && cache.snapshots.map(row => row.provider)).toEqual(["CURSOR", "CURSOR"]);
      expect(JSON.stringify(cache)).not.toContain("synthetic-auth");
      expect(JSON.stringify(cache)).not.toContain("synthetic-token");
      await runCli(["refresh"], { ...dependencies(state, home, recorder.transport, fixture.now), environment: {} });
      expect(recorder.sent).toHaveLength(1);
    } finally { db.close(); }
  });

  it("acquires every provider with an active polling reader", async () => {
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
      "CODEX",
      "GEMINI_CLI",
      "GROK",
      "KIMI",
      "OPENROUTER"
    ]);
    expect(result.stdout).toContain("codex yes read");
    expect(result.stdout).toContain("claude no off");
  });

  it("identifies itself as OpenLimiter and never as a vendor's client", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const recorder = recordingTransport();
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    expect(recorder.sent.length).toBeGreaterThan(0);
    for (const request of recorder.sent) {
      if (request.kind === "codex_app_server") continue;
      expect(request.headers["user-agent"]).toBe(OPENLIMITER_USER_AGENT);
      expect(request.headers["authorization"]).toBe("Bearer " + SYNTHETIC_TOKEN);
    }
    const codex = recorder.sent.find((request) => request.endpoint === "codex_usage");
    expect(codex).toMatchObject({
      kind: "codex_app_server",
      endpoint: "codex_usage",
      codexHome: path.join(home, ".codex"),
      expectedAccountId: opaqueAccountId("CODEX", SYNTHETIC_CODEX_ACCOUNT)
    });
    expect(JSON.stringify(codex)).not.toContain(SYNTHETIC_TOKEN);
    expect(JSON.stringify(codex)).not.toContain("Bearer ");
    expect(Object.keys(codex ?? {})).not.toEqual(expect.arrayContaining([
      "headers", "body", "url"
    ]));
    const grok = recorder.sent.find((request) => request.endpoint === "grok_billing");
    expect(grok?.kind).not.toBe("codex_app_server");
    if (grok === undefined || grok.kind === "codex_app_server") throw new Error("missing Grok request");
    expect(grok?.headers["x-userid"]).toBe(SYNTHETIC_GROK_USER);
    /* No vendor client marker anywhere. xAI's own tool sends
       x-xai-token-auth: xai-grok-cli, and sending it would be claiming to be
       that tool. */
    expect(Object.keys(grok?.headers ?? {})).not.toContain("x-xai-token-auth");
    expect(JSON.stringify(recorder.sent)).not.toContain("grok-cli");
    const quota = recorder.sent.find(
      (request) => request.endpoint === "code_assist_quota"
    );
    expect(quota?.kind).not.toBe("codex_app_server");
    if (quota === undefined || quota.kind === "codex_app_server") throw new Error("missing quota request");
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

  it("waits per the agreed exponential plan after a rate limit and a day after a refusal", async () => {
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
    expect(result.stdout).toContain("kimi yes stale 2026-01-01T00:01:00.000Z");
    expect(result.stdout).toContain("codex yes stale 2026-01-02T00:00:00.000Z");
    // The agreed plan records availability without inventing usage observations.
    const cached = await readSnapshotCache(state);
    expect(cached.ok && cached.snapshots.every((row) => row.meter === "ACQUISITION" && row.availability !== undefined)).toBe(true);
  });

  it("leaves the desktop owned provider alone while acquiring the other providers", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const desktopRow: Snapshot = {
      provider: "CODEX",
      accountId: opaqueAccountId("CODEX", SYNTHETIC_CODEX_ACCOUNT),
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
    expect(recorder.sent.some((request) => request.endpoint === "codex_usage")).toBe(false);
    expect(recorder.sent.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
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
      accountId: opaqueAccountId("CODEX", SYNTHETIC_CODEX_ACCOUNT),
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

  it("does not synthesize Antigravity rows from a Gemini login", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["refresh"], dependencies(state, home, recordingTransport().transport));
    const cached = await readSnapshotCache(state);
    const shared = (cached.ok ? cached.snapshots : []).filter(
      (snapshot) => snapshot.provider === "ANTIGRAVITY"
    );
    expect(shared).toEqual([]);
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
  it("does not poll without a recorded choice", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    const value = await runCli(
      ["config", "get", "providers.claude.poll"],
      dependencies(state, home, recordingTransport().transport)
    );
    expect(value.stdout).toBe("providers.claude.poll=unset");
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

  it("preserves a stored false choice", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "false"], dependencies(state, home, recordingTransport().transport));
    const recorder = recordingTransport();
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    expect(recorder.sent.some((request) => request.endpoint === "claude_usage")).toBe(false);
    expect((await runCli(["config", "get", "providers.claude.poll"], dependencies(state, home, recorder.transport))).stdout)
      .toBe("providers.claude.poll=false");
  });

  it("keeps the desktop and CLI choices independent in both directions", async () => {
    const home = await machineWithLogins();
    for (const [desktop, cli, expected] of [[false, true, true], [true, false, false]] as const) {
      const state = await temporaryDirectory("openlimiter-state-");
      await writeFile(path.join(state, "claude-poll.json"), JSON.stringify({ version: 1, enabled: desktop }), "utf8");
      await runCli(["config", "set", "providers.claude.poll", String(cli)], dependencies(state, home, recordingTransport().transport));
      const recorder = recordingTransport();
      await runCli(["refresh"], dependencies(state, home, recorder.transport));
      expect(recorder.sent.some((request) => request.endpoint === "claude_usage")).toBe(expected);
    }
  });

  it("keeps every broken configuration state off", async () => {
    const home = await machineWithLogins();
    const documents = [
      "not json",
      JSON.stringify([]),
      JSON.stringify({ version: 99, providers: { claude: { poll: true } } }),
      JSON.stringify({ version: 1, providers: { claude: { poll: "true" } } }),
      JSON.stringify({ version: 1, providers: { claude: { poll: true, recorded: false } } }),
      JSON.stringify({ version: 1, providers: { claude: { poll: true, recorded: "false" } } }),
    ];
    for (const document of documents) {
      const state = await temporaryDirectory("openlimiter-state-");
      await writeFile(path.join(state, "openlimiter-config.json"), document, "utf8");
      const recorder = recordingTransport();
      await runCli(["refresh"], dependencies(state, home, recorder.transport));
      expect(recorder.sent.some((request) => request.endpoint === "claude_usage")).toBe(false);
    }
    const oversized = await temporaryDirectory("openlimiter-state-");
    await writeFile(path.join(oversized, "openlimiter-config.json"), "x".repeat(1_048_577), "utf8");
    const recorder = recordingTransport();
    await runCli(["refresh"], dependencies(oversized, home, recorder.transport));
    expect(recorder.sent.some((request) => request.endpoint === "claude_usage")).toBe(false);

    const inaccessible = await temporaryDirectory("openlimiter-state-");
    await mkdir(path.join(inaccessible, "openlimiter-config.json"));
    const inaccessibleRecorder = recordingTransport();
    await runCli(["refresh"], dependencies(inaccessible, home, inaccessibleRecorder.transport));
    expect(inaccessibleRecorder.sent.some((request) => request.endpoint === "claude_usage"))
      .toBe(false);
  }, 15_000);

  it("honours the recorded marker at the acquisition boundary", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await writeFile(path.join(state, "openlimiter-config.json"), JSON.stringify({
      version: 1,
      providers: { claude: { poll: true, recorded: false } },
    }), "utf8");
    const recorder = recordingTransport();
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    expect(recorder.sent.some((request) => request.endpoint === "claude_usage")).toBe(false);
  });

  it("keeps a legacy boolean choice that predates the marker", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await writeFile(path.join(state, "openlimiter-config.json"), JSON.stringify({
      version: 1,
      providers: { claude: { poll: true } },
    }), "utf8");
    const recorder = recordingTransport();
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    expect(recorder.sent.some((request) => request.endpoint === "claude_usage")).toBe(true);
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
    expect(usage?.kind).not.toBe("codex_app_server");
    if (usage === undefined || usage.kind === "codex_app_server") throw new Error("missing Claude request");
    expect(usage?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  /* Hotfix 2.1.5, change E: a weekly Anthropic stops reporting disappears. */
  it("drops a weekly the next successful poll no longer reports", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    await runCli(["refresh"], dependencies(state, home, recordingTransport().transport));
    const weeklies = async () => {
      const cached = await readSnapshotCache(state);
      return (cached.ok ? cached.snapshots : []).filter((row) => row.provider === "CLAUDE" && row.meter.startsWith("SEVEN_DAY"))
        .map((row) => row.meter).sort();
    };
    expect(await weeklies()).toEqual(["SEVEN_DAY", "SEVEN_DAY_FABLE"]);
    const later = "2026-01-01T00:06:00.000Z";
    const withoutFable = recordingTransport(later, {
      claude_usage: {
        five_hour: { utilization: 23.5, resets_at: "2026-01-01T05:00:00.000Z" },
        seven_day: { utilization: 41.2, resets_at: "2026-01-08T00:00:00.000Z" }
      }
    });
    await runCli(["refresh"], dependencies(state, home, withoutFable.transport, later));
    expect(withoutFable.sent.some((request) => request.endpoint === "claude_usage")).toBe(true);
    expect(await weeklies()).toEqual(["SEVEN_DAY"]);
  });

  /* Hotfix 2.1.5 fix 4: a document that dropped a weekly bucket as malformed
     adds the rows it did read and deletes nothing (shared corpus case). */
  /* Hotfix 2.1.5 round 2 fix 3: the Claude report is written while the Claude
     lease is still held. A desktop read that lands after the lease is released,
     while this round is still busy with other providers, removes Fable, and
     nothing this round writes afterwards brings it back. */
  it("never brings back a weekly that a later desktop read removed", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    const earlier = new Date(Date.parse(NOW) - 6 * 60_000).toISOString();
    await runCli(["refresh"], dependencies(state, home, recordingTransport(earlier).transport, earlier));
    const weeklies = async () => {
      const cached = await readSnapshotCache(state);
      return (cached.ok ? cached.snapshots : []).filter((row) => row.provider === "CLAUDE" && row.meter.startsWith("SEVEN_DAY"));
    };
    const seen = await weeklies();
    expect(seen.map((row) => row.meter).sort()).toEqual(["SEVEN_DAY", "SEVEN_DAY_FABLE"]);
    // Every provider due again, so this round reads others after Claude.
    for (const name of await readdir(state)) {
      if (name.startsWith("acquisition") || name === ACQUISITION_STATE_FILE_NAME) await rm(path.join(state, name), { force: true });
    }
    const stored = seen.find((row) => row.meter === "SEVEN_DAY")!;
    const inner = recordingTransport(NOW);
    let landed = false;
    const transport: AcquisitionTransport = async (request) => {
      if (request.endpoint !== "claude_usage" && !landed) {
        landed = true;
        // The desktop reads once the Claude lease is free, and Fable is no longer
        // reported. Its week is the same one, so its reading is not lower.
        const later = new Date(Date.parse(NOW) + 301_000).toISOString();
        const desktop: Snapshot = { ...stored, value: 42, observedAt: later, expiresAt: new Date(Date.parse(later) + 465_000).toISOString(), writer: "desktop" };
        await mergeAuthoritativeSnapshotCache([desktop], state, later, { provider: "CLAUDE", accountId: stored.accountId, observedAt: later });
        const lease = path.join(state, "acquisition-claude.json");
        const held = JSON.parse(await readFile(lease, "utf8")) as Record<string, unknown>;
        await writeFile(lease, JSON.stringify({ ...held, owner: null, expiresAt: 0, token: "desktop-instance", nextAllowedAt: Date.parse(later) + 330_000 }));
      }
      return inner.transport(request);
    };
    await runCli(["refresh"], dependencies(state, home, transport, NOW));
    expect(landed).toBe(true);
    expect(inner.sent.some((request) => request.endpoint === "claude_usage")).toBe(true);
    expect((await weeklies()).map((row) => row.meter + " " + row.value)).toEqual(["SEVEN_DAY 42"]);
  });

  it("keeps the stored Fable when the next poll states a malformed Fable bucket", async () => {
    const corpus = JSON.parse(await readFile(path.resolve("packages/connectors/fixtures/cases/claude/weekly-fable-malformed.json"), "utf8")) as { now: string; body: unknown };
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    const first = new Date(Date.parse(corpus.now) - 6 * 60_000).toISOString();
    /* The read before it covers the same week (the desktop twin's sequence):
       a reading from an earlier week would now be ignored, not applied. */
    await runCli(["refresh"], dependencies(state, home, recordingTransport(first, { claude_usage: {
      seven_day: { utilization: 12, resets_at: "2026-08-11T12:00:00.000Z" },
      seven_day_fable: { utilization: 33, resets_at: "2026-08-11T12:00:00.000Z" }
    } }).transport, first));
    const weeklies = async () => {
      const cached = await readSnapshotCache(state);
      return (cached.ok ? cached.snapshots : []).filter((row) => row.provider === "CLAUDE" && row.meter.startsWith("SEVEN_DAY"))
        .map((row) => row.meter + " " + row.value).sort();
    };
    const before = await weeklies();
    expect(before.map((row) => row.split(" ")[0])).toEqual(["SEVEN_DAY", "SEVEN_DAY_FABLE"]);
    const partial = recordingTransport(corpus.now, { claude_usage: corpus.body });
    await runCli(["refresh"], dependencies(state, home, partial.transport, corpus.now));
    expect(partial.sent.some((request) => request.endpoint === "claude_usage")).toBe(true);
    expect(await weeklies()).toEqual(["SEVEN_DAY 18", before.find((row) => row.startsWith("SEVEN_DAY_FABLE"))]);
  });

  it("polls successfully when the response has no model scoped results", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    const recorder = recordingTransport(NOW, {
      claude_usage: {
        five_hour: { utilization: 23.5, resets_at: "2026-01-01T05:00:00.000Z" },
        seven_day: { utilization: 41.2, resets_at: "2026-01-08T00:00:00.000Z" }
      }
    });
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    const cached = await readSnapshotCache(state);
    const meters = cached.ok ? cached.snapshots.filter((row) => row.provider === "CLAUDE").map((row) => row.meter).sort() : [];
    expect(meters).toEqual(["FIVE_HOUR", "SEVEN_DAY"]);
  });

  /* Hotfix 2.1.5 fix 3: when the desktop polled and then exited, the shared
     lease and its persisted deadline decide when this tool asks Claude, never
     the age of the desktop's rows. Checked at the cadence and at a reset. */
  it.each([
    ["the cadence", 330_000, null],
    ["a reset", 120_000, 120_000]
  ] as const)("takes Claude over from an exited desktop at %s", async (_boundary, deadlineIn, resetIn) => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    const polledAt = Date.parse(NOW);
    const account = opaqueAccountId("CLAUDE", "one-active-account-without-stable-identity");
    // What the desktop leaves behind after one read: its rows and the shared deadline.
    await writeFile(path.join(state, "acquisition-claude.json"), JSON.stringify({
      lastAccount: account, owner: null, expiresAt: 0, token: "desktop-instance",
      nextAllowedAt: polledAt + deadlineIn, attempts: 0, refusalRevision: null
    }), "utf8");
    const desktopWeekly: Snapshot = {
      provider: "CLAUDE",
      accountId: account,
      meter: "SEVEN_DAY",
      value: 41,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: 604_800 },
      resetAt: new Date(polledAt + (resetIn ?? 4 * 86_400_000)).toISOString(),
      source: "internal_payload",
      precision: "exact",
      observedAt: NOW,
      expiresAt: new Date(polledAt + 435_000).toISOString(),
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "internal-endpoint",
        automationRisk: "high",
        verification: "UNVERIFIED"
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
      writer: "desktop"
    };
    await mergeAuthoritativeSnapshotCache([desktopWeekly], state, NOW);
    const at = new Date(polledAt + deadlineIn + 10_000).toISOString();
    const started: string[][] = [];
    await runCli(["statusline"], {
      ...dependencies(state, home, recordingTransport().transport, at),
      readStandardInput: async () => JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 9, resets_at: Date.parse("2026-01-01T04:00:00.000Z") / 1000 } }
      }),
      spawnDetached: (executable: string, argumentsList: readonly string[]) => {
        started.push([executable, ...argumentsList]);
      },
      nodeExecutable: "/usr/bin/node",
      openLimiterScript: "/opt/openlimiter/bin.js"
    });
    expect(started).toHaveLength(1);
    const recorder = recordingTransport(at);
    await runCli(["refresh"], dependencies(state, home, recorder.transport, at));
    expect(recorder.sent.some((request) => request.endpoint === "claude_usage")).toBe(true);
  });

  /* Hotfix 2.1.5, change A: a desktop row from its session window is not a
     desktop poll, so it never stands this tool down for the weeklies. */
  it("polls Claude beside a recent desktop session row that no weekly poll backs", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    const desktopSession: Snapshot = {
      provider: "CLAUDE",
      accountId: opaqueAccountId("CLAUDE", "one-active-account-without-stable-identity"),
      meter: "FIVE_HOUR",
      value: 12,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: 18_000 },
      resetAt: "2026-01-01T04:00:00.000Z",
      source: "internal_payload",
      precision: "exact",
      observedAt: NOW,
      expiresAt: "2026-01-01T00:19:00.000Z",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "internal-endpoint",
        automationRisk: "high",
        verification: "UNVERIFIED"
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
      writer: "desktop"
    };
    await writeSnapshotCache([desktopSession], state);
    const recorder = recordingTransport();
    await runCli(["refresh"], dependencies(state, home, recorder.transport));
    expect(recorder.sent.some((request) => request.endpoint === "claude_usage")).toBe(true);
  });

  it("starts a refresh from a render whose Claude session is fresh and whose weekly is not", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    const weekly: Snapshot = {
      provider: "CLAUDE",
      accountId: opaqueAccountId("CLAUDE", "one-active-account-without-stable-identity"),
      meter: "SEVEN_DAY",
      value: 41,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: 604_800 },
      resetAt: "2026-01-05T00:00:00.000Z",
      source: "internal_payload",
      precision: "exact",
      observedAt: NOW,
      expiresAt: "2026-01-01T00:19:00.000Z",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "internal-endpoint",
        automationRisk: "high",
        verification: "UNVERIFIED"
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
      writer: "cli"
    };
    await writeSnapshotCache([weekly], state);
    const started: string[][] = [];
    const later = "2026-01-01T00:03:00.000Z";
    const render = await runCli(["statusline"], {
      ...dependencies(state, home, recordingTransport().transport, later),
      readStandardInput: async () => JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 9, resets_at: Date.parse("2026-01-01T04:00:00.000Z") / 1000 } }
      }),
      spawnDetached: (executable: string, argumentsList: readonly string[]) => {
        started.push([executable, ...argumentsList]);
      },
      nodeExecutable: "/usr/bin/node",
      openLimiterScript: "/opt/openlimiter/bin.js"
    });
    expect(render.exitCode).toBe(0);
    expect(started).toEqual([["/usr/bin/node", "/opt/openlimiter/bin.js", "refresh", "--detached"]]);
  });

  /* Hotfix 2.1.5, change D: the reading from before a weekly reset leaves the
     status line at the reset even when the poll after it fails, and storage
     keeps it. */
  it("withdraws a weekly at its reset when the poll after it fails, and keeps it stored", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    const weekly: Snapshot = {
      provider: "CLAUDE",
      accountId: opaqueAccountId("CLAUDE", "one-active-account-without-stable-identity"),
      meter: "SEVEN_DAY",
      value: 75,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: 604_800 },
      resetAt: "2026-01-01T00:10:00.000Z",
      source: "internal_payload",
      precision: "exact",
      observedAt: NOW,
      expiresAt: "2026-01-01T00:19:00.000Z",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "internal-endpoint",
        automationRisk: "high",
        verification: "UNVERIFIED"
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
      writer: "cli"
    };
    await mergeAuthoritativeSnapshotCache([weekly], state, NOW);
    const render = async (at: string) => (await runCli(["statusline"], {
      ...dependencies(state, home, recordingTransport().transport, at),
      readStandardInput: async () => JSON.stringify({
        rate_limits: { five_hour: { used_percentage: 9, resets_at: Date.parse("2026-01-01T04:00:00.000Z") / 1000 } }
      })
    })).stdout;
    expect(await render("2026-01-01T00:09:59.000Z")).toContain("75%");
    const after = "2026-01-01T00:10:30.000Z";
    const failing: AcquisitionTransport = async () => ({ status: 503, body: "", retryAfterSeconds: null });
    await runCli(["refresh"], dependencies(state, home, failing, after));
    const line = await render(after);
    expect(line).not.toContain("75%");
    expect(line).not.toContain("0%");
    expect(line).toContain("7d waiting");
    const stored = await readSnapshotCache(state);
    expect(stored.ok && stored.snapshots.filter((row) => row.meter === "SEVEN_DAY").map((row) => row.value)).toEqual([75]);
  });

  /* Hotfix 2.1.5, change G: the round that read the weeklies uploads them to
     the hub before it ends, so the phone does not wait for another sync. */
  it("uploads the weeklies a successful Claude poll read in the same round", async () => {
    const state = await temporaryDirectory("openlimiter-state-");
    const home = await machineWithLogins();
    await runCli(["config", "set", "providers.claude.poll", "true"], dependencies(state, home, recordingTransport().transport));
    await writeSession({
      version: 1,
      token: "t".repeat(32),
      expiresAt: "2026-01-01T06:00:00.000Z",
      refreshCredential: "r".repeat(32),
      refreshExpiresAt: "2026-02-01T00:00:00.000Z",
      deviceId: "device-1234",
      accountLabel: "person@example.com"
    }, { directory: state, platform: "linux" });
    const uploads: string[] = [];
    const base = dependencies(state, home, recordingTransport().transport);
    const result = await runCli(["refresh"], {
      ...base,
      environment: { ...base?.environment, OPENLIMITER_SUPABASE_ANON_KEY: "sb_publishable_test_key" },
      hubTransport: async (request) => {
        uploads.push(request.body);
        return { status: 200, body: JSON.stringify({ accepted: true, sequence: 1, tier: "free" }) };
      }
    });
    expect(result.exitCode).toBe(0);
    expect(uploads.some((body) => body.includes("SEVEN_DAY_FABLE"))).toBe(true);
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
