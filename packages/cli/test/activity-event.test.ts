import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { eventCommand, mapHookActivity, readEventInput, EVENT_INPUT_MAX_BYTES } from "../src/activity/event.js";
import { readActivitySpool } from "../../core/src/activity/spool.js";
import { runCli } from "../src/cli.js";

// The root harness relocates tests to .test-dist and aliases package imports.
// Give Node's resolver the real CLI package location, as an installed CLI has.
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return { ...actual, createRequire: () => actual.createRequire(process.cwd() + "/packages/cli/package.json") };
});

const roots: string[] = [];
const now = Date.now();
const silent = { exitCode: 0, stdout: "", stderr: "" };
const matrix = [
  ["claude", "SessionStart", "idle"], ["claude", "UserPromptSubmit", "busy"],
  ["claude", "Notification", "waiting"], ["claude", "Stop", "done"], ["claude", "SessionEnd", "unknown"],
  ["codex", "SessionStart", "idle"], ["codex", "UserPromptSubmit", "busy"],
  ["codex", "PermissionRequest", "waiting"], ["codex", "Stop", "done"], ["codex", "SessionEnd", "unknown"],
  ["muse", "SessionStart", "idle"], ["muse", "UserPromptSubmit", "busy"], ["muse", "PermissionRequest", "waiting"],
  ["muse", "Notification", "waiting"], ["muse", "Stop", "done"], ["muse", "SessionEnd", "unknown"],
  ["gemini", "SessionStart", "idle"], ["gemini", "BeforeAgent", "busy"], ["gemini", "Notification", "waiting"],
  ["gemini", "AfterAgent", "done"], ["gemini", "SessionEnd", "unknown"],
  ["cursor", "sessionStart", "idle"], ["cursor", "beforeSubmitPrompt", "busy"],
  ["cursor", "stop", "done"], ["cursor", "sessionEnd", "unknown"]
] as const;
function directory(): string {
  const value = mkdtempSync(path.join(tmpdir(), "openlimiter-event-")); roots.push(value); return value;
}

async function windowsEventProcess(kind: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string; elapsed: number }> {
  // Node's named stdio pipes are denied in some Windows sandboxes. The native
  // process API uses anonymous pipes, as the shipped PowerShell launcher does.
  const io = directory();
  const script = path.join(io, "event.ps1"), result = path.join(io, "result.json");
  const profileVariables = ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"];
  const quote = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
  writeFileSync(script, `
$ErrorActionPreference = 'Stop'
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = ${quote(process.execPath)}
$info.Arguments = ${quote('"' + path.resolve("packages/cli/dist/bin.js") + '" event --agent codex --event Stop')}
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
${profileVariables.map((name) => `$info.EnvironmentVariables[${quote(name)}] = ${quote(env[name]!)}`).join("\n")}
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
$watch = [System.Diagnostics.Stopwatch]::StartNew()
try {
  [void]$child.Start()
  $child.StandardInput.AutoFlush = $true
  try {
    ${kind === "stalled" ? "$child.StandardInput.Write('{\"session_id\":')" : `$child.StandardInput.Write('{"session_id":"oversized","prompt":"' + ('x' * ${EVENT_INPUT_MAX_BYTES}) + '"}')`}
  } catch { if ($_.Exception.GetBaseException() -isnot [System.IO.IOException]) { throw } }
  if (!$child.WaitForExit(2000)) { $child.Kill(); throw 'Event entry retained stdin beyond its deadline' }
  $watch.Stop()
  $value = @{ code = $child.ExitCode; stdout = $child.StandardOutput.ReadToEnd(); stderr = $child.StandardError.ReadToEnd(); elapsed = $watch.Elapsed.TotalMilliseconds }
  [System.IO.File]::WriteAllText(${quote(result)}, ($value | ConvertTo-Json -Compress))
} finally { $child.Dispose() }
`);
  const diagnostics = path.join(io, "driver-output");
  const fd = openSync(diagnostics, "w");
  const driverEnv = { ...env, ...Object.fromEntries(profileVariables.map((name) => [name, io])) };
  try { await new Promise<void>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
      env: driverEnv, windowsHide: true, stdio: ["ignore", fd, fd], timeout: 10000
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Event test driver exited ${code}: ${readFileSync(diagnostics, "utf8")}`)));
  }); } finally { closeSync(fd); }
  return JSON.parse(readFileSync(result, "utf8")) as { code: number; stdout: string; stderr: string; elapsed: number };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("activity event", () => {
  it("publishes a silent hook event through a symlinked state root", async () => {
    const root = directory();
    const alias = path.join(directory(), "linked-root");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await eventCommand(["event", "--agent", "codex", "--event", "Stop"], {
      stateDirectory: alias,
      readStandardInput: async () => JSON.stringify({ session_id: "linked-root-session" }),
      protectWindowsDirectory: async () => undefined
    })).toEqual(silent);
    expect(readActivitySpool(root)).toMatchObject({ skipped: 0, events: [expect.objectContaining({ sessionId: "linked-root-session", state: "done" })] });
  });

  it.each(matrix)("maps %s %s to %s using only structural fields", (agent, name, state) => {
    const event = mapHookActivity(agent, name, {
      session_id: "session", conversation_id: "conversation", hook_event_name: name,
      notification_type: agent === "gemini" ? "ToolPermission" : "permission_prompt", status: "completed",
      pid: 123456, ppid: 654321, process: { ppid: 999999 }
    }, now);
    expect(event).toMatchObject({ state, process: { ppid: process.ppid }, sessionId: agent === "cursor" ? "conversation" : "session" });
    expect(event?.process).not.toHaveProperty("pid");
    expect(event?.process).not.toHaveProperty("startedAt");
  });

  it("distinguishes questions, approvals, idle notices, failures, cancellations, and sidechains", () => {
    const payload = { session_id: "session" };
    expect(mapHookActivity("claude", "Notification", { ...payload, notification_type: "elicitation_dialog" }, now)?.signal).toBe("user_question");
    expect(mapHookActivity("claude", "Notification", { ...payload, notification_type: "idle_prompt" }, now)?.confidence).toBe("inferred");
    expect(mapHookActivity("claude", "Notification", { ...payload, notification_type: "auth_success" }, now)).toBeNull();
    expect(mapHookActivity("cursor", "stop", { ...payload, status: "error" }, now)).toMatchObject({ state: "unknown", outcome: "failed" });
    expect(mapHookActivity("cursor", "stop", { ...payload, status: "aborted" }, now)).toMatchObject({ state: "unknown", outcome: "cancelled" });
    expect(mapHookActivity("codex", "Stop", { ...payload, agent_id: "child" }, now)?.isSidechain).toBe(true);
    expect(mapHookActivity("claude", "Stop", payload, now)?.signal).toBe("claude_stop");
    expect(mapHookActivity("muse", "Stop", { ...payload, stop_hook_active: true }, now)?.state).toBe("busy");
  });

  it.each([null, [], {}, { session_id: "../../escape" }, { session_id: "session", hook_event_name: "Wrong" }])("rejects missing, malformed and path identities", (payload) => {
    expect(mapHookActivity("codex", "Stop", payload, now)).toBeNull();
  });

  it("never spools free text, tool arguments, prompts, transcript paths or approval text for any agent", async () => {
    const stateDirectory = directory();
    const marker = "PRIVATE_MARKER_NEVER_STORE";
    const free = Object.fromEntries(["prompt", "transcript_path", "cwd", "permission_mode", "model", "turn_id", "agent_type",
      "message", "title", "last_assistant_message", "tool_name", "approval_text", "error_message", "reason", "source",
      "agent_message", "user_email", "final_status", "summary"].map((field) => [field, marker]));
    for (const [agent, name] of matrix) {
      const payload = { ...free, session_id: "safe-session", conversation_id: "safe-conversation", hook_event_name: name,
        notification_type: agent === "gemini" ? "ToolPermission" : "permission_prompt", status: "completed",
        tool_input: { command: marker }, tool_arguments: { text: marker }, details: { message: marker }, workspace_roots: [marker], transcript: marker };
      expect(await eventCommand(["event", "--agent", agent, "--event", name], {
        stateDirectory, readStandardInput: async () => JSON.stringify(payload), protectWindowsDirectory: async () => undefined
      })).toEqual(silent);
    }
    const spool = path.join(stateDirectory, "activity");
    expect(readdirSync(spool).filter((file) => file !== ".acl-verified")).toHaveLength(matrix.length);
    for (const file of readdirSync(spool)) expect(readFileSync(path.join(spool, file), "utf8")).not.toContain(marker);
  });

  it("bounds streaming stdin and cancels a stalled read", async () => {
    const input = new PassThrough();
    const result = readEventInput(undefined, input);
    input.write(Buffer.alloc(EVENT_INPUT_MAX_BYTES + 1));
    expect(await result).toBeNull();
    expect(input.listenerCount("data")).toBe(0);
    const controller = new AbortController();
    const stalledInput = new PassThrough();
    const stalled = readEventInput(controller.signal, stalledInput);
    controller.abort();
    expect(await stalled).toBeNull();
    for (const stream of [input, stalledInput]) {
      for (const event of ["data", "end", "error", "close"]) expect(stream.listenerCount(event)).toBe(0);
      expect(stream.isPaused()).toBe(true);
      expect(stream.destroyed).toBe(true);
    }
  });

  it.each(["stalled", "oversized"])("shipped entry releases %s stdin and exits silently without writing", async (kind) => {
    const root = directory();
    const env = { ...process.env };
    for (const name of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]) env[name] = root;
    const start = performance.now();
    const result = process.platform === "win32" ? await windowsEventProcess(kind, env) : await new Promise<{ code: number | null; stdout: string; stderr: string; elapsed: number }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve("packages/cli/dist/bin.js"), "event", "--agent", "codex", "--event", "Stop"], {
        env, windowsHide: true, stdio: "pipe"
      });
      let stdout = "", stderr = "";
      const timeout = setTimeout(() => { child.kill(); reject(new Error("Event entry retained stdin beyond its deadline")); }, 2000);
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr, elapsed: performance.now() - start }); });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
      // Never send EOF. Both cases must release the actual pipe themselves.
      child.stdin.write(kind === "stalled" ? '{"session_id":' : JSON.stringify({ session_id: "oversized", prompt: "x".repeat(EVENT_INPUT_MAX_BYTES) }));
    });
    const { elapsed, ...output } = result;
    console.info(`activity shipped ${kind} input exit ms: ${elapsed.toFixed(2)}`);
    expect(output).toEqual({ code: 0, stdout: "", stderr: "" });
    // Includes Node startup plus the 100 ms input deadline, with scheduling headroom.
    expect(elapsed).toBeLessThan(1000);
    expect(readdirSync(root)).toEqual([]);
  });

  it.each(["{", "[]", " ".repeat(EVENT_INPUT_MAX_BYTES + 1)])("is silent and exits zero for rejected input", async (raw) => {
    const stateDirectory = directory();
    expect(await eventCommand(["event", "--agent", "codex", "--event", "Stop"], { stateDirectory, readStandardInput: async () => raw })).toEqual(silent);
    expect(readdirSync(stateDirectory)).toEqual([]);
  });

  it("routes through the CLI without calling fetch or starting refresh or desktop work", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const stateDirectory = directory();
    expect(await runCli(["event", "--agent", "codex", "--event", "Stop"], {
      stateDirectory, readStandardInput: async () => "{}"
    })).toEqual(silent);
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(stateDirectory)).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("passes the session ACL runner and permits cold verification beyond the warm deadline", async () => {
    const stateDirectory = directory();
    const windowsAclRunner = vi.fn(async (executable: string) => {
      if (executable.endsWith("whoami.exe")) return { ok: true, stdout: '"fixture","S-1-5-21-111-222-333-1001"', stderr: "", exitCode: 0 };
      await new Promise((resolve) => setTimeout(resolve, 160));
      return { ok: true, stdout: "PRIVATE", stderr: "", exitCode: 0 };
    });
    const dependencies = { stateDirectory, windowsAclRunner, readStandardInput: async () => JSON.stringify({ session_id: "cold" }) };
    expect(await runCli(["event", "--agent", "codex", "--event", "UserPromptSubmit"], dependencies)).toEqual(silent);
    expect(windowsAclRunner).toHaveBeenCalledTimes(2);
    expect(readActivitySpool(stateDirectory).events).toHaveLength(1);
    windowsAclRunner.mockClear();
    expect(await runCli(["event", "--agent", "codex", "--event", "Stop"], dependencies)).toEqual(silent);
    expect(windowsAclRunner).not.toHaveBeenCalled();
    expect(readActivitySpool(stateDirectory).events).toHaveLength(2);
  });

  it.each(["muse", "cursor"])("routes the %s hook alias to its lifecycle installer", async (agent) => {
    const homeDirectory = directory();
    const dependencies = { homeDirectory, openLimiterScript: path.join(homeDirectory, "bin.js"), nodeExecutable: process.execPath };
    writeFileSync(dependencies.openLimiterScript, "// fixture executable\n");
    expect(await runCli(["hooks", "install", agent], dependencies)).toMatchObject({ exitCode: 0 });
    expect((await runCli(["hooks", "install", agent], dependencies)).stdout).toContain("changed=no");
    expect(await runCli(["hooks", "uninstall", agent], dependencies)).toMatchObject({ exitCode: 0 });
  });

  it("measures typical local mapping and spool time under 150 ms with the ACL dependency supplied", async () => {
    const stateDirectory = directory();
    const times: number[] = [];
    for (let index = 0; index < 10; index++) {
      const start = performance.now();
      expect(await eventCommand(["event", "--agent", "codex", "--event", "UserPromptSubmit"], {
        stateDirectory, readStandardInput: async () => JSON.stringify({ session_id: "timing", hook_event_name: "UserPromptSubmit", prompt: "private" }),
        protectWindowsDirectory: async () => undefined
      })).toEqual(silent);
      times.push(performance.now() - start);
    }
    expect(readActivitySpool(stateDirectory).events).toHaveLength(10);
    expect(Math.max(...times)).toBeLessThan(150);
    console.info("activity dependency supplied timing ms:", times.map((value) => value.toFixed(2)).join(", "));
  });
});
