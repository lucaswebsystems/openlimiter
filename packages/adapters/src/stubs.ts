import type { Advice } from "@openlimiter/core";
import { buildAgentContext } from "./claude-code.js";

export const HOOK_INPUT_MAX_BYTES = 65_536;

export type AgentId =
  | "antigravity"
  | "claude"
  | "codex"
  | "gemini"
  | "grok"
  | "kimi"
  | "opencode";

export interface AgentAdapter {
  readonly id: string;
  render(advice: Advice): string;
}

export interface AgentHookRequest {
  agent: AgentId;
  hostVersion: string;
  rawInput: string | null;
  context: string;
}

export interface AgentHookResult {
  stdout: string;
  diagnostic: "" | "event" | "input" | "oversized" | "version";
  exitCode: 0;
}

export interface AgentCompatibilityGate {
  testedVersions: readonly string[];
  launchState: "included" | "gated" | "experimental" | "excluded";
}

export const AGENT_COMPATIBILITY: Readonly<Record<AgentId, AgentCompatibilityGate>> = {
  claude: { testedVersions: ["2.1.257"], launchState: "included" },
  codex: { testedVersions: ["0.152.0"], launchState: "included" },
  gemini: { testedVersions: [], launchState: "gated" },
  antigravity: { testedVersions: [], launchState: "gated" },
  kimi: { testedVersions: [], launchState: "gated" },
  opencode: { testedVersions: ["1.18.11"], launchState: "experimental" },
  grok: { testedVersions: [], launchState: "excluded" }
};

interface InputContract {
  eventKey: string | null;
  eventName: string;
  required: Readonly<Record<string, "integer" | "nullable_string" | "string" | "string_array">>;
  optional: Readonly<Record<string, "boolean" | "integer" | "nullable_string" | "object" | "string" | "string_array">>;
}

const commonClaude = {
  session_id: "string",
  transcript_path: "string",
  cwd: "string",
  permission_mode: "string",
  hook_event_name: "string",
  prompt: "string"
} as const;

const contracts: Readonly<Record<Exclude<AgentId, "grok">, InputContract>> = {
  claude: {
    eventKey: "hook_event_name",
    eventName: "UserPromptSubmit",
    required: commonClaude,
    optional: {
      agent_id: "string",
      agent_type: "string",
      prompt_id: "string"
    }
  },
  codex: {
    eventKey: "hook_event_name",
    eventName: "UserPromptSubmit",
    required: {
      session_id: "string",
      transcript_path: "nullable_string",
      cwd: "string",
      permission_mode: "string",
      hook_event_name: "string",
      model: "string",
      turn_id: "string",
      prompt: "string"
    },
    optional: {
      agent_id: "string",
      agent_type: "string"
    }
  },
  gemini: {
    eventKey: "hook_event_name",
    eventName: "BeforeAgent",
    required: {
      session_id: "string",
      transcript_path: "string",
      cwd: "string",
      hook_event_name: "string",
      timestamp: "string",
      prompt: "string"
    },
    optional: {}
  },
  antigravity: {
    eventKey: null,
    eventName: "PreInvocation",
    required: {
      conversationId: "string",
      workspacePaths: "string_array",
      transcriptPath: "string",
      artifactDirectoryPath: "string",
      invocationNum: "integer",
      initialNumSteps: "integer"
    },
    optional: {}
  },
  kimi: {
    eventKey: "hook_event_name",
    eventName: "UserPromptSubmit",
    required: {
      hook_event_name: "string",
      session_id: "string",
      session_title: "string",
      client_type: "string",
      cwd: "string"
    },
    optional: {}
  },
  opencode: {
    eventKey: "hook_event_name",
    eventName: "OpenCodeSystemTransform",
    required: {
      hook_event_name: "string",
      session_id: "string",
      cwd: "string"
    },
    optional: {}
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (type === "nullable_string") return value === null || typeof value === "string";
  if (type === "string_array") {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
  if (type === "object") return typeof value === "object" && value !== null;
  return typeof value === type;
}

function validInput(value: unknown, contract: InputContract): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...Object.keys(contract.required), ...Object.keys(contract.optional)]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  for (const [key, type] of Object.entries(contract.required)) {
    if (!matchesType(value[key], type)) return false;
  }
  for (const [key, type] of Object.entries(contract.optional)) {
    if (value[key] !== undefined && !matchesType(value[key], type)) return false;
  }
  return contract.eventKey === null || value[contract.eventKey] === contract.eventName;
}

function empty(agent: AgentId, diagnostic: AgentHookResult["diagnostic"]): AgentHookResult {
  return {
    stdout: agent === "antigravity" || agent === "gemini" ? "{}" : "",
    diagnostic,
    exitCode: 0
  };
}

function render(agent: Exclude<AgentId, "grok">, context: string): string {
  if (context === "") return agent === "antigravity" || agent === "gemini" ? "{}" : "";
  if (agent === "kimi" || agent === "opencode") return context;
  if (agent === "antigravity") {
    return JSON.stringify({ injectSteps: [{ ephemeralMessage: context }] });
  }
  if (agent === "gemini") {
    return JSON.stringify({ hookSpecificOutput: { additionalContext: context } });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context
    }
  });
}

function runValidatedAgentHook(request: AgentHookRequest): AgentHookResult {
  if (request.agent === "grok") return empty("grok", "event");
  if (request.rawInput === null) return empty(request.agent, "input");
  if (Buffer.byteLength(request.rawInput, "utf8") > HOOK_INPUT_MAX_BYTES) {
    return empty(request.agent, "oversized");
  }
  let input: unknown;
  try {
    input = JSON.parse(request.rawInput) as unknown;
  } catch {
    return empty(request.agent, "input");
  }
  const contract = contracts[request.agent];
  if (!validInput(input, contract)) return empty(request.agent, "event");
  if (request.agent === "antigravity" && input["invocationNum"] !== 0) {
    return empty(request.agent, "");
  }
  return { stdout: render(request.agent, request.context), diagnostic: "", exitCode: 0 };
}

export function runAgentHook(request: AgentHookRequest): AgentHookResult {
  if (request.agent === "grok") return empty("grok", "event");
  const gate = AGENT_COMPATIBILITY[request.agent];
  if (!gate.testedVersions.includes(request.hostVersion)) {
    return empty(request.agent, "version");
  }
  return runValidatedAgentHook(request);
}

/** Test fixture seam for hosts that have no passing version gate yet. */
export function runAgentHookFixture(request: AgentHookRequest): AgentHookResult {
  return runValidatedAgentHook(request);
}

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude_code",
  render: buildAgentContext
};

export const codexCliAdapter: AgentAdapter = {
  id: "codex_cli",
  render: buildAgentContext
};

export const geminiCliAdapter: AgentAdapter = {
  id: "gemini_cli",
  render: buildAgentContext
};

export const antigravityAdapter: AgentAdapter = {
  id: "antigravity",
  render: buildAgentContext
};

export const kimiCliAdapter: AgentAdapter = {
  id: "kimi_cli",
  render: buildAgentContext
};

export const opencodeAdapter: AgentAdapter = {
  id: "opencode_experimental",
  render: buildAgentContext
};
