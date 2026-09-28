import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
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
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("activity event", () => {
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
    const stalled = readEventInput(controller.signal, new PassThrough());
    controller.abort();
    expect(await stalled).toBeNull();
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
