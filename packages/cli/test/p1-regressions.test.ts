import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireRefreshLock, buildAdvice, codexUsageRequest, createFetchTransport,
  getAgyInstallRoots, isTrustedAgyExecutable, enumerateAgyListeningPorts,
  normalizeMeters, parseAgyQuotaSummary, readAcquisitionCredential,
  readSnapshotCache, registerManagedCodexAccount, shouldStartRefresh,
  writeSnapshotCache, type Snapshot
} from "@openlimiter/core";
import { claudeFixture, parseOpenrouterPayload } from "@openlimiter/connectors";
import { runCli, runtimeDependencies, type CliDependencies } from "../src/cli.js";
import { DEFAULT_STATUSLINE, readStatuslineConfig } from "../src/config.js";
import { parseAntigravityStatuslinePayload, readStandardInputBuffer, readStandardInputText, STDIN_BYTE_LIMIT } from "../src/ingest.js";
import { readSession, writeSession, SESSION_FILE_NAME, SESSION_LOCK_NAME, SESSION_LOCK_WAIT_MILLISECONDS, type HubSession } from "../src/session.js";
import { DELIVERY_UNCONFIRMED_SENTENCE, runDeviceLogin, CODE_CONSUMED_SENTENCE } from "../src/hub-auth.js";
import { cliLoginStartRequest, createFetchHubTransport } from "../src/hub.js";
import { apiSpendSamplesFromSnapshots, SYNC_CURSOR_FILE_NAME } from "../src/hub-sync.js";
import { barStyleCells, renderStatuslineLayout, STATUSLINE_HOSTS } from "../src/statusline.js";
import { credentialDocuments, recordedResponses } from "./fixtures/acquisition.js";

vi.mock("../src/terminal-launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/terminal-launcher.js")>();
  return { ...actual, installLauncher: async (directory: string) => ({ node: process.execPath, entry: path.join(directory, "test-launcher.cjs") }) };
});

const NOW = "2026-09-07T12:00:00.000Z";
const ENV = { PATH: "", Path: "", OPENLIMITER_SUPABASE_ANON_KEY: "sb_publishable_test_key" };
const roots: string[] = [];
async function scratch(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "openlimiter-p1-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function row(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    provider: "CODEX", meter: "FIVE_HOUR", value: 25, unit: "PERCENT",
    window: { kind: "rolling", durationSeconds: 18000 }, resetAt: null,
    source: "internal_payload", precision: "estimated", observedAt: NOW,
    expiresAt: "2026-09-07T12:05:00.000Z",
    labels: { credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint", automationRisk: "high", verification: "UNVERIFIED" },
    ...overrides
  };
}
function session(): HubSession {
  return { version: 1, token: "t".repeat(32), refreshCredential: "r".repeat(32),
    expiresAt: NOW, refreshExpiresAt: "2026-10-07T12:00:00.000Z", deviceId: "test-device", accountLabel: "Test" };
}
async function deps(): Promise<CliDependencies> {
  const root = await scratch();
  return {
    stateDirectory: path.join(root, "state"), homeDirectory: path.join(root, "home"),
    platform: "linux", environment: ENV, now: () => NOW,
    promptChoice: async () => "s", promptForSecret: async () => "", payloads: {},
    colorOutput: false, readStandardInput: async () => null,
    nodeExecutable: process.execPath, openLimiterScript: "test-cli.js",
    spawnDetached: () => undefined, emit: () => undefined, sleep: async () => undefined,
    openBrowser: () => undefined, detectedAgentInstallations: {},
    credentialStore: { get: async () => null, set: async () => undefined },
    acquisitionTransport: async (request) => {
      const body = recordedResponses(NOW)[request.endpoint];
      return { status: body === undefined ? 404 : 200, body: JSON.stringify(body ?? {}), retryAfterSeconds: null };
    },
    hubTransport: async () => ({ status: 503, body: "" }),
    codexDeviceLoginRunnerFactory: () => ({ start: async () => { throw new Error("Unexpected login"); } })
  };
}

describe("P1 audit regressions", () => {
  it("01 creates fresh state before session writes and refresh locks and distinguishes an unavailable lock", async () => {
    const root = await scratch();
    const state = path.join(root, "nested", "state");
    await writeSession(session(), { directory: state, platform: "linux" });
    expect(await readSession(state)).not.toBeNull();
    const lock = await acquireRefreshLock(path.join(root, "fresh"));
    expect(lock.ok).toBe(true);
    if (lock.ok) await lock.release();
    const blocked = path.join(root, "file");
    await writeFile(blocked, "x");
    expect(await acquireRefreshLock(blocked)).toEqual({ ok: false, reason: "unavailable" });
    const result = await runCli(["refresh"], { ...await deps(), stateDirectory: blocked });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.includes("already running")).toBe(false);
  });

  it("04 validates, registers and rescans a managed Codex login before success and collects quota", async () => {
    const d = await deps();
    let managed = "";
    const emitted: string[] = [];
    const result = await runCli(["setup"], {
      ...d, emit: (line) => emitted.push(line),
      detectedAgentInstallations: { codex: { version: "0.153.3", executable: "synthetic-codex", fileSize: 1, mtimeMilliseconds: 1 } },
      promptChoice: async (question) => question.startsWith("Codex has") ? "" : "s",
      codexDeviceLoginRunnerFactory: () => ({ start: async (home) => {
        managed = home;
        await writeFile(path.join(home, "auth.json"), JSON.stringify(credentialDocuments.codex));
        return { nextLine: async () => "ABCD1234 https://auth.openai.com/device", finished: () => true, stop: () => undefined };
      } })
    });
    expect(emitted).toContain("Codex: signed in.");
    expect(managed).not.toBe("");
    const found = await readAcquisitionCredential("CODEX", { stateDirectory: d.stateDirectory!, homeDirectory: d.homeDirectory, environment: {}, platform: "linux", now: NOW });
    expect(found.ok).toBe(true);
    const cache = await readSnapshotCache(d.stateDirectory);
    expect(cache.ok && cache.snapshots.some((snapshot) => snapshot.provider === "CODEX")).toBe(true);
    const invalid = path.join(d.stateDirectory!, "accounts", "codex", "invalid");
    await mkdir(invalid, { recursive: true });
    await writeFile(path.join(invalid, "auth.json"), "{}");
    expect(await registerManagedCodexAccount(d.stateDirectory!, "invalid", NOW)).toBe(false);
    await writeFile(path.join(invalid, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic-access-token-0000" } }));
    expect(await registerManagedCodexAccount(d.stateDirectory!, "invalid", NOW)).toBe(false);
  });

  it("07 fresh Claude ingestion cannot suppress stale Codex acquisition or independently due sync", async () => {
    const snapshots = [row({ provider: "CLAUDE" }), row({ observedAt: "2026-09-07T11:00:00.000Z" })];
    expect(shouldStartRefresh(snapshots, NOW)).toEqual({ refresh: true });
    const d = await deps();
    await writeSession(session(), { directory: d.stateDirectory!, platform: "linux" });
    const calls: string[][] = [];
    await runCli(["statusline"], { ...d,
      spawnDetached: (_exe, args) => calls.push([...args]),
      readStandardInput: async () => JSON.stringify(claudeFixture(NOW))
    });
    const cache = await readSnapshotCache(d.stateDirectory);
    expect(cache.ok && cache.snapshots.some((snapshot) => snapshot.provider === "CLAUDE" && snapshot.observedAt === NOW)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("08 renders each setup section once and acquires before host prompts", async () => {
    const d = await deps();
    await mkdir(path.join(d.homeDirectory, ".codex"), { recursive: true });
    await writeFile(path.join(d.homeDirectory, ".codex", "auth.json"), JSON.stringify(credentialDocuments.codex));
    const emitted: string[] = [];
    const timeline: string[] = [];
    d.acquisitionTransport = async (request) => {
      timeline.push("acquire:" + request.endpoint);
      const body = recordedResponses(NOW)[request.endpoint];
      return { status: body === undefined ? 404 : 200, body: JSON.stringify(body ?? {}), retryAfterSeconds: null };
    };
    let accepted = false;
    const result = await runCli(["setup"], { ...d, emit: (line) => emitted.push(line),
      promptChoice: async (question) => {
        timeline.push("prompt:" + question);
        if (question === "Enter to accept: ") {
          expect(emitted.some((line) => line.startsWith("codex:"))).toBe(true);
          accepted = true;
        }
        return question.startsWith("claude: Enter to install") ? "" : "s";
      }
    });
    expect(accepted).toBe(true);
    expect(await readFile(path.join(d.homeDirectory, ".claude", "settings.json"), "utf8")).toContain("openlimiter");
    const output = [...emitted, result.stdout].filter(Boolean).join("\n");
    expect(output.match(/^1\. Sign in$/gm)?.length).toBe(1);
    expect(output.match(/^2\. Connect$/gm)?.length).toBe(1);
    expect(output.match(/^3\. Show bars in$/gm)?.length).toBe(1);
    expect(output.match(/^CODEX/gm)?.length).toBe(1);
    expect(timeline.findIndex((entry) => entry === "acquire:codex_usage")).toBeGreaterThan(
      timeline.findIndex((entry) => entry === "prompt:Enter to accept: ")
    );
    expect(timeline.findIndex((entry) => entry.startsWith("prompt:claude: Enter to install"))).toBeGreaterThan(
      timeline.findIndex((entry) => entry === "acquire:codex_usage")
    );
    const cache = await readSnapshotCache(d.stateDirectory);
    expect(cache.ok && cache.snapshots.length > 0).toBe(true);
  }, 20_000);

  it("09 selects a provider from the same credential inventory as refresh without payload markers", async () => {
    const d = await deps();
    await mkdir(path.join(d.homeDirectory, ".codex"), { recursive: true });
    await writeFile(path.join(d.homeDirectory, ".codex", "auth.json"), JSON.stringify(credentialDocuments.codex));
    const result = await runCli(["terminal", "show", "codex"], d);
    expect(result.exitCode).toBe(0);
    expect((await readStatuslineConfig(d.stateDirectory)).show).toEqual(["codex"]);
  });

  it("13 shows actual OpenRouter money with a spend label and freshness on every host", () => {
    const snapshots = normalizeMeters(parseOpenrouterPayload({ data: { total_credits: 20, total_usage: 6.4 } }, NOW) ?? []);
    for (const host of STATUSLINE_HOSTS) {
      const render = (now: string) => barStyleCells(snapshots, now, ["OPENROUTER"], host, [], "all", false).map((cell) => cell.plain).join(" ");
      expect(render(NOW)).toBe("or spend $6.40");
      expect(render("2026-09-07T12:03:01.000Z")).toContain("~or spend $6.40");
      expect(render("2026-09-07T12:16:00.000Z")).not.toContain("$6.40");
    }
  });

  it("14 preserves four pool identities from the shared capture in both ingress paths", async () => {
    const capture = JSON.parse(await readFile(path.join(process.cwd(), "packages/connectors/fixtures/live/antigravity.quota.capture.json"), "utf8")) as { groups: { buckets: { poolPrefix: string; window: string; remainingFraction: number }[] }[] };
    const probe = parseAgyQuotaSummary(capture, NOW);
    const quota = Object.fromEntries(capture.groups.flatMap((group) => group.buckets.map((bucket) => [bucket.poolPrefix + "-" + bucket.window, bucket])));
    const ingest = parseAntigravityStatuslinePayload({ quota }, NOW);
    const identities = ["FIVE_HOUR", "SEVEN_DAY", "THIRD_PARTY_SESSION", "THIRD_PARTY_WEEKLY"];
    expect(probe?.map((meter) => meter.meter).sort()).toEqual(identities);
    expect(ingest?.map((meter) => meter.meter).sort()).toEqual(identities);
    expect(normalizeMeters(probe ?? [])).toHaveLength(4);
    expect(normalizeMeters(ingest ?? [])).toHaveLength(4);
  });

  it("21 establishes an OpenRouter lifetime baseline before monthly spend appears", async () => {
    const snapshots = normalizeMeters(parseOpenrouterPayload({ data: { total_credits: 20, total_usage: 6.4 } }, NOW) ?? []);
    expect(snapshots[0]?.usedAmount).toBe(6.4);
    expect(snapshots[0]?.window.kind).toBe("lifetime");
    expect(await apiSpendSamplesFromSnapshots(snapshots, NOW, (await deps()).stateDirectory)).toEqual([]);
  });

  it.each([403, 404, 409, 410])("22 stops on terminal poll status %i after one poll", async (status) => {
    let calls = 0;
    const result = await runDeviceLogin({ environment: ENV, sleep: async () => undefined, emit: () => undefined, open: false,
      transport: async () => ++calls === 1 ? { status: 200, body: JSON.stringify({ user_code: "ABCD1234", device_code: "device-code-0001", verification_url: "https://openlimiter.com/device", interval: 1, expires_in: 30 }) } : { status, body: status === 403 ? JSON.stringify({ message: "the server rejected this proof" }) : "{}" }
    });
    expect(calls).toBe(2);
    expect(result.kind).toBe(status === 403 ? "denied" : "expired");
    if (status === 409) expect(result).toEqual({ kind: "expired", message: CODE_CONSUMED_SENTENCE });
    if (status === 403) expect(result).toEqual({ kind: "denied", message: "the server rejected this proof" });
  });

  it("writes the session before the single successful acknowledgement", async () => {
    const d = await deps();
    const actions: string[] = [];
    d.hubTransport = async (request) => {
      const body = JSON.parse(request.body) as Record<string, string>;
      actions.push(body["action"] ?? "");
      if (body["action"] === "start") {
        return { status: 200, body: JSON.stringify({ user_code: "ABCD1234", device_code: "device-code-0001", verification_url: "https://openlimiter.com/device", interval: 1, expires_in: 30 }) };
      }
      if (body["action"] === "poll") {
        return { status: 200, body: JSON.stringify({ status: "approved", token: "n".repeat(32), expires_at: "2026-09-07T20:00:00.000Z", refresh_credential: "z".repeat(32), refresh_expires_at: "2026-10-07T12:00:00.000Z", device_id: "test-device" }) };
      }
      expect(await readSession(d.stateDirectory)).not.toBeNull();
      expect(body["device_code"]).toBe("device-code-0001");
      expect(body["token"]).toBe("n".repeat(32));
      expect(body["client_proof"]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      return { status: 200, body: JSON.stringify({ status: "consumed" }) };
    };
    const result = await runCli(["login"], d);
    expect(result.exitCode).toBe(0);
    expect(actions).toEqual(["start", "poll", "ack"]);
  });

  it("keeps the stored session usable when acknowledgement returns gone", async () => {
    const d = await deps();
    d.hubTransport = async (request) => {
      const action = (JSON.parse(request.body) as { action: string }).action;
      if (action === "start") return { status: 200, body: JSON.stringify({ user_code: "ABCD1234", device_code: "device-code-0001", verification_url: "https://openlimiter.com/device", interval: 1, expires_in: 30 }) };
      if (action === "poll") return { status: 200, body: JSON.stringify({ status: "approved", token: "n".repeat(32), expires_at: "2026-09-07T20:00:00.000Z", refresh_credential: "z".repeat(32), refresh_expires_at: "2026-10-07T12:00:00.000Z", device_id: "test-device" }) };
      return { status: 410, body: "" };
    };
    const result = await runCli(["login"], d);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(DELIVERY_UNCONFIRMED_SENTENCE);
    expect(await readSession(d.stateDirectory)).not.toBeNull();
  });

  it("23 serializes explicit and background renewal and preserves the replacement session and cursor", async () => {
    const d = await deps();
    await writeSession(session(), { directory: d.stateDirectory!, platform: "linux" });
    await writeSnapshotCache([row()], d.stateDirectory);
    let renewals = 0;
    let sequence = 0;
    d.hubTransport = async (request) => {
      if (request.body.includes("grant_renew")) {
        renewals++;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return renewals > 1 ? { status: 401, body: "{}" } : { status: 200, body: JSON.stringify({ token: "n".repeat(32), expires_at: "2026-09-07T20:00:00.000Z", refresh_credential: "z".repeat(32), refresh_expires_at: "2026-10-07T12:00:00.000Z" }) };
      }
      const envelope = JSON.parse(request.body) as { previous_sequence: number; sequence: number };
      expect(envelope.previous_sequence).toBe(sequence);
      sequence = envelope.sequence;
      return { status: 200, body: JSON.stringify({ accepted: true, sequence, tier: "free" }) };
    };
    const results = await Promise.all([runCli(["sync"], d), runCli(["refresh"], d)]);
    expect(results.every((result) => result.exitCode === 0)).toBe(true);
    expect(renewals).toBe(1);
    expect(await readSession(d.stateDirectory)).not.toBeNull();
    expect(sequence).toBe(2);
    expect(JSON.parse(await readFile(path.join(d.stateDirectory!, SYNC_CURSOR_FILE_NAME), "utf8")).sequence).toBe(2);
  });

  it("serializes login and logout mutations behind the session lock", async () => {
    const d = await deps();
    const held = await acquireRefreshLock(d.stateDirectory!, Date.now(), SESSION_LOCK_NAME);
    expect(held.ok).toBe(true);
    d.hubTransport = async (request) => request.body.includes('"action":"start"')
      ? { status: 200, body: JSON.stringify({ user_code: "ABCD1234", device_code: "device-code-0001", verification_url: "https://openlimiter.com/device", interval: 1, expires_in: 30 }) }
      : { status: 200, body: JSON.stringify({ status: "approved", token: "n".repeat(32), expires_at: "2026-09-07T20:00:00.000Z", refresh_credential: "z".repeat(32), refresh_expires_at: "2026-10-07T12:00:00.000Z", device_id: "test-device" }) };
    const login = runCli(["login"], d);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await readSession(d.stateDirectory)).toBeNull();
    if (held.ok) await held.release();
    await expect(login).resolves.toMatchObject({ exitCode: 0 });
    expect(await readSession(d.stateDirectory)).not.toBeNull();

    await writeSession(session(), { directory: d.stateDirectory!, platform: "linux" });
    const second = await acquireRefreshLock(d.stateDirectory!, Date.now(), SESSION_LOCK_NAME);
    expect(second.ok).toBe(true);
    const logout = runCli(["logout"], d);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await readSession(d.stateDirectory)).not.toBeNull();
    if (second.ok) await second.release();
    await expect(logout).resolves.toMatchObject({ exitCode: 0 });
    expect(await readSession(d.stateDirectory)).toBeNull();
  });

  it("returns the session lock diagnostic through the logout command", async () => {
    const d = await deps();
    const held = await acquireRefreshLock(d.stateDirectory!, Date.now(), SESSION_LOCK_NAME);
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    vi.useFakeTimers();
    try {
      const pending = runCli(["logout"], d);
      await vi.advanceTimersByTimeAsync(SESSION_LOCK_WAIT_MILLISECONDS + 25);
      const result = await pending;
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Private session storage at");
      expect(result.stderr).toContain("\"" + path.join(d.stateDirectory!, SESSION_LOCK_NAME) + "\"");
      expect(result.stderr).toContain("wait for the session lock");
    } finally {
      vi.useRealTimers();
      await held.release();
    }
  });

  it("returns the ACL repair diagnostic through the login command", async () => {
    const d = await deps();
    const result = await runCli(["login"], {
      ...d,
      platform: "win32",
      hubTransport: async (request) => {
        const action = (JSON.parse(request.body) as { action: string }).action;
        if (action === "start") return { status: 200, body: JSON.stringify({ user_code: "ABCD1234", device_code: "device-code-0001", verification_url: "https://openlimiter.com/device", interval: 1, expires_in: 30 }) };
        if (action === "poll") return { status: 200, body: JSON.stringify({ status: "approved", token: "n".repeat(32), expires_at: "2026-09-07T20:00:00.000Z", refresh_credential: "z".repeat(32), refresh_expires_at: "2026-10-07T12:00:00.000Z", device_id: "test-device" }) };
        return { status: 200, body: JSON.stringify({ status: "consumed" }) };
      },
      windowsAclRunner: async (executable) => executable.endsWith("whoami.exe")
        ? { ok: true as const, stdout: '"test","S-1-5-21-1-2-3-1001"' }
        : { ok: false as const, stdout: "" }
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Private session storage at");
    expect(result.stderr).toContain("icacls \"" + d.stateDirectory + "\" /reset");
    expect(result.stderr).not.toContain("n".repeat(32));
  });

  it.each(["failed", "unverified", "missing"])("24 never writes credentials after %s Windows ACL protection", async (mode) => {
    const root = await scratch();
    const directory = path.join(root, "state");
    await expect(writeSession(session(), { directory, platform: "win32", ...(mode === "missing" ? {} : { windowsAclRunner: async (exe: string) => {
      expect(await readSession(directory)).toBeNull();
      if (exe.endsWith("whoami.exe")) return { ok: true as const, stdout: '"test","S-1-5-21-1-2-3-1001"' };
      return mode === "failed" ? { ok: false as const } : { ok: true as const, stdout: "" };
    } }) })).rejects.toThrow();
    await expect(readFile(path.join(directory, SESSION_FILE_NAME))).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("24 verifies the actual Windows ACL before both initial and replacement writes", async (context) => {
    const directory = path.join(await scratch(), "state");
    const runner = runtimeDependencies().windowsAclRunner;
    if (runner === undefined) throw new Error("Missing Windows runner");
    const tool = path.win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "whoami.exe");
    const capability = await runner(tool, ["/user", "/fo", "csv", "/nh"], 5000).catch(() => ({ ok: false as const }));
    if (!capability.ok) return context.skip();
    await writeSession(session(), { directory, platform: "win32", windowsAclRunner: runner });
    await writeSession(session(), { directory, platform: "win32", windowsAclRunner: runner });
    expect(await readSession(directory)).not.toBeNull();
  });

  it("27 keeps hiding the last provider empty in both renderers, while automatic selection still works", async () => {
    const d = await deps();
    d.environment = { ...ENV, CODEX_USAGE_PAYLOAD: "available" };
    await mkdir(path.join(d.homeDirectory, ".codex"), { recursive: true });
    await writeFile(path.join(d.homeDirectory, ".codex", "auth.json"), JSON.stringify(credentialDocuments.codex));
    await runCli(["terminal", "show", "codex"], d);
    await runCli(["terminal", "hide", "codex"], d);
    const config = await readStatuslineConfig(d.stateDirectory);
    for (const style of ["bar", "cells"] as const) {
      const input = { snapshots: [row()], advice: buildAdvice([row()], NOW), now: NOW, color: false };
      const rendered = renderStatuslineLayout({ ...input, config: { ...config, style } });
      expect(rendered.includes("25%")).toBe(false);
      expect(rendered.includes("25.0%")).toBe(false);
      expect(renderStatuslineLayout({ ...input, config: { ...DEFAULT_STATUSLINE, style } })).toContain("25");
    }
  });

  it("30 refuses a downloaded agy executable and a process owned by another user", async () => {
    const roots = getAgyInstallRoots("win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" });
    expect(isTrustedAgyExecutable("C:\\Users\\test\\AppData\\Local\\Temp\\download\\agy.exe", "win32", roots)).toBe(false);
    expect(isTrustedAgyExecutable("C:\\Users\\test\\AppData\\Local\\Programs\\Antigravity\\agy.exe", "win32", roots)).toBe(true);
    const ports = await enumerateAgyListeningPorts({ platform: "darwin", currentUserId: 1000,
      resolveExecutablePath: async () => "/usr/bin/agy",
      resolveExecutableOwner: async () => 2000,
      runCommand: async (exe) => ({ ok: true, stdout: exe === "lsof" ? "p123\nn127.0.0.1:12345\n" : "2000" })
    });
    expect(ports).toEqual([]);
  });

  it("35 cancels overflowing HTTP producers without buffering their entire response", async () => {
    for (const kind of ["hub", "acquisition"] as const) {
      let cancellationStarted = false;
      let releaseCancellation: () => void = () => undefined;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(65536)); },
        cancel() {
          cancellationStarted = true;
          return new Promise<void>((resolve) => { releaseCancellation = resolve; });
        }
      });
      const fakeFetch: typeof fetch = async () => new Response(body, { status: 200 });
      let returned = false;
      const pending = (kind === "hub" ? createFetchHubTransport(fakeFetch)(cliLoginStartRequest(ENV)!) :
        createFetchTransport(fakeFetch)(codexUsageRequest("synthetic-access-token-0000", "synthetic-account")!)).then((reply) => {
        returned = true;
        return reply;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(cancellationStarted).toBe(true);
      expect(returned).toBe(false);
      releaseCancellation();
      const reply = await pending;
      expect(reply.body).toBe("");
      expect(returned).toBe(true);
    }
  });

  it("35 destroys oversized status line stdin for wrapped and text modes", async () => {
    for (const wrapped of [true, false]) {
      const stream = new Readable({ read() { this.push(Buffer.alloc(STDIN_BYTE_LIMIT + 1)); } });
      const result = wrapped ? await readStandardInputBuffer(stream as NodeJS.ReadStream) : await readStandardInputText(stream as NodeJS.ReadStream);
      expect(result === null || result.length === 0).toBe(true);
      expect(stream.destroyed).toBe(true);
    }
  });
});
