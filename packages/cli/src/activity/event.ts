import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Readable } from "node:stream";
import { resolveStateDirectory } from "@openlimiter/core";
import type { ActivityEvent, ActivityAgent } from "../../../core/dist/activity/contract.js";
// Resolve beside the installed core entry, including when tests relocate the CLI.
// The package export map is frozen outside this unit's write scope.
const coreEntry = pathToFileURL(createRequire(import.meta.url).resolve("@openlimiter/core"));
const { isActivityEvent, isContractObject } = await import(new URL("./activity/contract.js", coreEntry).href) as typeof import("../../../core/dist/activity/contract.js");
const { writeActivityEvent } = await import(new URL("./activity/spool.js", coreEntry).href) as typeof import("../../../core/dist/activity/spool.js");

export const EVENT_INPUT_MAX_BYTES = 65_536;
export const EVENT_DEADLINE_MS = 100;
const agents: Readonly<Record<string, ActivityAgent>> = {
  claude: "claude_code", codex: "codex", muse: "muse", gemini: "gemini_cli", cursor: "cursor"
};
const events: Readonly<Record<string, readonly string[]>> = {
  claude: ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"],
  codex: ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "SessionEnd"],
  muse: ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Notification", "Stop", "SessionEnd"],
  gemini: ["SessionStart", "BeforeAgent", "Notification", "AfterAgent", "SessionEnd"],
  cursor: ["sessionStart", "beforeSubmitPrompt", "stop", "sessionEnd"]
};

/** Every retained value is structural. Never spread, stringify or inspect free text. */
export function mapHookActivity(agentName: string, eventName: string, payload: unknown, now = Date.now()): ActivityEvent | null {
  const agent = agents[agentName];
  if (!agent || !events[agentName]?.includes(eventName) || !isContractObject(payload)) return null;
  if (payload["hook_event_name"] !== undefined && payload["hook_event_name"] !== eventName) return null;
  const sessionId = agent === "cursor" ? payload["conversation_id"] ?? payload["session_id"] : payload["session_id"];
  if (typeof sessionId !== "string" || /[\\/]/u.test(sessionId) || sessionId === "." || sessionId === "..") return null;
  const event: ActivityEvent = {
    version: 1, eventId: randomUUID(), sessionId, sequence: now * 1_000,
    agent, observedAt: new Date(now).toISOString(), state: "unknown", source: "hook",
    confidence: "explicit", process: { ppid: process.ppid }, signal: "observation"
  };
  if (eventName === "SessionStart" || eventName === "sessionStart") event.state = "idle";
  else if (["UserPromptSubmit", "BeforeAgent", "beforeSubmitPrompt"].includes(eventName)) event.state = "busy";
  else if (eventName === "PermissionRequest") event.state = "waiting";
  else if (eventName === "Notification") {
    const kind = payload["notification_type"];
    if ((agent === "gemini_cli" && kind === "ToolPermission") ||
      ((agent === "claude_code" || agent === "muse") && kind === "permission_prompt")) event.state = "waiting";
    else if (agent === "claude_code" && kind === "elicitation_dialog") {
      event.state = "waiting";
      event.signal = "user_question";
    } else if (agent === "claude_code" && kind === "idle_prompt") {
      event.state = "idle";
      event.confidence = "inferred";
    } else return null;
  } else if (eventName === "SessionEnd" || eventName === "sessionEnd") {
    event.signal = "session_ended";
    if (agent === "cursor" && payload["reason"] === "aborted") event.outcome = "cancelled";
    if (agent === "cursor" && payload["reason"] === "error") event.outcome = "failed";
  } else if (agent === "cursor") {
    if (payload["status"] === "completed") event.state = "done";
    else if (payload["status"] === "aborted") event.outcome = "cancelled";
    else if (payload["status"] === "error") event.outcome = "failed";
    else return null;
  } else {
    event.state = payload["stop_hook_active"] === true ? "busy" : "done";
    if (agent === "claude_code" && event.state === "done") event.signal = "claude_stop";
  }
  // Codex uses the parent's session_id on child hooks. Suppress those observations.
  if ((agent === "codex" || agent === "claude_code") && typeof payload["agent_id"] === "string") event.isSidechain = true;
  return isActivityEvent(event, now) ? event : null;
}

export interface EventDependencies {
  stateDirectory?: string;
  readStandardInput: (signal?: AbortSignal) => Promise<string | null>;
  protectWindowsDirectory?: (directory: string) => Promise<void>;
}

export async function eventCommand(argumentsList: readonly string[], dependencies: EventDependencies): Promise<{ exitCode: 0; stdout: ""; stderr: "" }> {
  const deadline = new AbortController();
  const expires = performance.now() + EVENT_DEADLINE_MS;
  let timer = setTimeout(() => deadline.abort(), EVENT_DEADLINE_MS);
  try {
    const flag = (name: string): string => {
      const index = argumentsList.indexOf(name);
      return index < 0 ? "" : argumentsList[index + 1] ?? "";
    };
    const raw = await Promise.race([
      dependencies.readStandardInput(deadline.signal),
      new Promise<null>((resolve) => deadline.signal.addEventListener("abort", () => resolve(null), { once: true }))
    ]);
    if (deadline.signal.aborted || raw === null || Buffer.byteLength(raw) > EVENT_INPUT_MAX_BYTES) return { exitCode: 0, stdout: "", stderr: "" };
    const now = Date.now();
    const event = mapHookActivity(flag("--agent"), flag("--event"), JSON.parse(raw) as unknown, now);
    const options = {
      directory: dependencies.stateDirectory ?? resolveStateDirectory(), now, signal: deadline.signal, deadline: expires,
      ...(dependencies.protectWindowsDirectory ? { protectWindowsDirectory: async (directory: string) => {
        // Cold ACL verification is outside the warm hook budget.
        const remaining = Math.max(0, options.deadline - performance.now());
        clearTimeout(timer);
        await dependencies.protectWindowsDirectory!(directory);
        options.deadline = performance.now() + remaining;
        timer = setTimeout(() => deadline.abort(), remaining);
      } } : {})
    };
    if (event !== null) await writeActivityEvent(event, options);
  } catch { /* Activity must never affect the host, including malformed stdin and disk failures. */ }
  finally { clearTimeout(timer); deadline.abort(); }
  return { exitCode: 0, stdout: "", stderr: "" };
}

/** A bounded streaming reader for the standalone hook entry, with no retained tail. */
export function readEventInput(signal?: AbortSignal, input: Readable = process.stdin): Promise<string | null> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (value: string | null): void => {
      if (finished) return;
      finished = true;
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("error", failed);
      input.removeListener("close", failed);
      signal?.removeEventListener("abort", failed);
      input.pause();
      input.destroy();
      chunks = [];
      resolve(value);
    };
    const data = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > EVENT_INPUT_MAX_BYTES) finish(null);
      else chunks.push(bytes);
    };
    const end = (): void => {
      try { finish(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { finish(null); }
    };
    const failed = (): void => finish(null);
    if (signal?.aborted) { finish(null); return; }
    input.on("data", data).once("end", end).once("error", failed).once("close", failed);
    signal?.addEventListener("abort", failed, { once: true });
  });
}
