import type { Advice } from "@openlimiter/core";
import {
  AGENT_CONTEXT_SCALAR_LIMIT,
  SPILL_CONTEXT_NOTICE,
  buildAgentContext,
  unicodeScalarLength
} from "./claude-code.js";
import { validatedUntrustedLines } from "./agent-context-cache.js";

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
  diagnostic: AgentContextDiagnosticCode;
  exitCode: 0;
}

export type AgentContextDiagnosticCode =
  | ""
  | "context"
  | "event"
  | "input"
  | "oversized"
  | "version";

export interface AgentContextAdapterV1Input {
  agent_id: AgentId;
  hook_event: string;
  host_version: string;
  invocation_id: string;
  invocation_number?: number;
  cwd?: string;
  raw_input: string;
}

export interface AgentContextAdapterV1Output {
  inject_text: string;
  spill_reference: string;
  diagnostic_code: AgentContextDiagnosticCode;
  exit_code: 0;
}

export interface AgentContextAdapterV1 {
  readonly version: 1;
  execute(
    input: AgentContextAdapterV1Input,
    validatedContext: string
  ): AgentContextAdapterV1Output;
}

export interface AgentCompatibilityGate {
  minimumTestedVersion: string | null;
  launchState: "included" | "gated" | "experimental" | "excluded";
}

export const AGENT_COMPATIBILITY: Readonly<Record<AgentId, AgentCompatibilityGate>> = {
  claude: { minimumTestedVersion: "2.1.257", launchState: "included" },
  codex: { minimumTestedVersion: "0.152.0", launchState: "included" },
  gemini: { minimumTestedVersion: null, launchState: "gated" },
  antigravity: { minimumTestedVersion: null, launchState: "excluded" },
  kimi: { minimumTestedVersion: null, launchState: "gated" },
  opencode: { minimumTestedVersion: "1.18.11", launchState: "experimental" },
  grok: { minimumTestedVersion: null, launchState: "excluded" }
};

export type AgentVersionCompatibility =
  | "newer"
  | "older"
  | "supported"
  | "unsupported";

function semanticVersion(value: string): readonly [number, number, number] | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
  if (match === null) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function agentVersionCompatibility(
  agent: AgentId,
  version: string
): AgentVersionCompatibility {
  const minimum = AGENT_COMPATIBILITY[agent].minimumTestedVersion;
  const actualParts = semanticVersion(version);
  const minimumParts = minimum === null ? null : semanticVersion(minimum);
  if (actualParts === null || minimumParts === null) return "unsupported";
  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index]! > minimumParts[index]!) return "newer";
    if (actualParts[index]! < minimumParts[index]!) return "older";
  }
  return "supported";
}

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
      cwd: "string",
      prompt: "string"
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

function emptyContract(
  diagnosticCode: AgentContextDiagnosticCode
): AgentContextAdapterV1Output {
  return {
    inject_text: "",
    spill_reference: "",
    diagnostic_code: diagnosticCode,
    exit_code: 0
  };
}

function executeSharedContract(
  input: AgentContextAdapterV1Input,
  validatedContext: string,
  allowUntestedVersion: boolean
): AgentContextAdapterV1Output {
  if (input.agent_id === "grok") return emptyContract("event");
  const contract = contracts[input.agent_id];
  if (
    input.hook_event !== contract.eventName ||
    input.invocation_id === "" ||
    (input.invocation_number !== undefined &&
      (!Number.isSafeInteger(input.invocation_number) || input.invocation_number < 0)) ||
    (input.cwd !== undefined && typeof input.cwd !== "string")
  ) return emptyContract("event");
  if (Buffer.byteLength(input.raw_input, "utf8") > HOOK_INPUT_MAX_BYTES) {
    return emptyContract("oversized");
  }
  if (
    !allowUntestedVersion &&
    !["supported", "newer"].includes(
      agentVersionCompatibility(input.agent_id, input.host_version)
    )
  ) return emptyContract("version");
  if (input.agent_id === "antigravity" && input.invocation_number !== 0) {
    return emptyContract("");
  }
  if (validatedContext === "") return emptyContract("");
  if (
    unicodeScalarLength(validatedContext) > AGENT_CONTEXT_SCALAR_LIMIT ||
    validatedUntrustedLines(validatedContext) === null
  ) return emptyContract("context");
  return {
    inject_text: validatedContext,
    spill_reference: validatedContext.includes(SPILL_CONTEXT_NOTICE)
      ? SPILL_CONTEXT_NOTICE
      : "",
    diagnostic_code: "",
    exit_code: 0
  };
}

export const agentContextAdapterV1: AgentContextAdapterV1 = {
  version: 1,
  execute(input, validatedContext) {
    return executeSharedContract(input, validatedContext, false);
  }
};

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

function normalizedInput(
  request: AgentHookRequest,
  input: Record<string, unknown>,
  contract: InputContract
): AgentContextAdapterV1Input {
  const invocationId = request.agent === "antigravity"
    ? input["conversationId"]
    : input["session_id"];
  const cwd = input["cwd"];
  const invocationNumber = input["invocationNum"];
  return {
    agent_id: request.agent,
    hook_event: contract.eventName,
    host_version: request.hostVersion,
    invocation_id: typeof invocationId === "string" ? invocationId : "",
    ...(typeof invocationNumber === "number"
      ? { invocation_number: invocationNumber }
      : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    raw_input: request.rawInput ?? ""
  };
}

function runValidatedAgentHook(
  request: AgentHookRequest,
  allowUntestedVersion: boolean
): AgentHookResult {
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
  const result = executeSharedContract(
    normalizedInput(request, input, contract),
    request.context,
    allowUntestedVersion
  );
  return {
    stdout: render(request.agent, result.inject_text),
    diagnostic: result.diagnostic_code,
    exitCode: result.exit_code
  };
}

export function runAgentHook(request: AgentHookRequest): AgentHookResult {
  return runValidatedAgentHook(request, false);
}

/** Test fixture seam for hosts that have no passing version gate yet. */
export function runAgentHookFixture(request: AgentHookRequest): AgentHookResult {
  return runValidatedAgentHook(request, true);
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
