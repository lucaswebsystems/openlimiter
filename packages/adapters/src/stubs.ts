import type { Advice } from "@openlimiter/core";

export interface AgentAdapter {
  readonly id: string;
  render(advice: Advice): string;
}

export const codexCliAdapter: AgentAdapter = {
  id: "codex_cli",
  render() {
    return "";
  }
};

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  render() {
    return "";
  }
};

export const p2AdapterWork = [
  "TODO: Implement Codex CLI in P2.",
  "TODO: Implement OpenCode in P2."
] as const;
