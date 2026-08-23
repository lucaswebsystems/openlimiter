import { describe, expect, it } from "vitest";
import providerSpecs from "../../../provider_specs/provider-specs.json" with { type: "json" };
import {
  PROVIDER_RECOGNITION_ORDER,
  buildProviderDirectory,
} from "../src/provider-connect.js";

describe("provider connection directory", () => {
  it("keeps one explicit recognition order for all provider surfaces", () => {
    expect(PROVIDER_RECOGNITION_ORDER).toEqual([
      "openai/codex",
      "anthropic/claude-code",
      "google/gemini-cli",
      "google/antigravity",
      "xai/api",
      "moonshot/api",
      "opencode/opencode",
      "openrouter/api",
    ]);
  });

  it("shows only the eight providers with collecting connectors", () => {
    const rows = buildProviderDirectory(providerSpecs);

    expect(rows).toHaveLength(8);
    expect(rows.filter((row) => row.availability === "ready").map((row) => row.displayName))
      .toEqual([
        "Codex",
        "Claude Code",
        "Gemini CLI",
        "Antigravity",
        "Grok (xAI)",
        "Kimi",
        "OpenCode",
        "OpenRouter",
      ]);
    expect(rows.some((row) => row.availability === "planned")).toBe(false);
    expect(rows.some((row) => row.connectorId === "manual")).toBe(false);
  });

  it("classifies the eight collecting providers by their real access path", () => {
    const rows = buildProviderDirectory(providerSpecs);
    const byId = new Map(rows.map((row) => [row.specId, row]));

    expect(byId.get("anthropic/claude-code")?.access).toBe("automatic");
    expect(byId.get("openrouter/api")?.access).toBe("key");
    expect(byId.get("xai/api")?.access).toBe("automatic");
    expect(byId.get("moonshot/api")?.access).toBe("automatic");
    expect(byId.get("google/gemini-cli")).toMatchObject({
      access: "automatic",
      connectorId: "gemini-cli",
      availability: "ready",
    });
    expect(byId.get("xai/api")).toMatchObject({
      connectorId: "grok",
      availability: "ready",
      stateLabel: "Not found",
      actionLabel: "Scan again",
      stateTone: "quiet",
    });
    expect(byId.get("moonshot/api")).toMatchObject({
      connectorId: "kimi",
      availability: "ready",
    });
    expect(rows.every((row) => row.availability === "ready")).toBe(true);
  });

  it("turns runtime state into one concise state and one action", () => {
    const rows = buildProviderDirectory(providerSpecs, {
      states: {
        claude: "CONNECTED",
        codex: "DETECTED",
        openrouter: "NEEDS_AUTH",
      },
    });
    const byConnector = new Map(rows.map((row) => [row.connectorId, row]));

    expect(byConnector.get("claude")).toMatchObject({
      stateLabel: "Connected",
      action: "refresh",
      actionLabel: "Refresh",
    });
    expect(byConnector.get("codex")).toMatchObject({
      stateLabel: "Detected",
      action: "enable",
      actionLabel: "Enable",
    });
    expect(byConnector.get("openrouter")).toMatchObject({
      stateLabel: "Key needed",
      action: "connect",
      actionLabel: "Connect",
    });
  });

  it("keeps every required connection state distinct across all eight rows", () => {
    const rows = buildProviderDirectory(providerSpecs, {
      states: {
        claude: "CONNECTED",
        codex: "NEEDS_AUTH",
        "gemini-cli": "DEGRADED",
        antigravity: "STALE",
      },
    });
    const byConnector = new Map(rows.map((row) => [row.connectorId, row]));

    expect(rows).toHaveLength(8);
    expect(byConnector.get("claude")).toMatchObject({
      access: "automatic",
      stateLabel: "Connected",
      stateTone: "live",
    });
    expect(byConnector.get("codex")).toMatchObject({
      access: "automatic",
      stateLabel: "Sign in",
      stateTone: "attention",
    });
    expect(byConnector.get("openrouter")).toMatchObject({
      access: "key",
      stateLabel: "Key needed",
      stateTone: "quiet",
    });
    expect(byConnector.get("gemini-cli")).toMatchObject({
      stateLabel: "Retrying",
      stateTone: "attention",
    });
    expect(byConnector.get("antigravity")).toMatchObject({
      stateLabel: "Stale",
      stateTone: "attention",
    });
    expect(byConnector.get("grok")).toMatchObject({
      stateLabel: "Not found",
      stateTone: "quiet",
    });
  });
});
