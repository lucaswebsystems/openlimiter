import { describe, expect, it } from "vitest";
import { WAVE_PROVIDERS, isEnabledProviderCode } from "@openlimiter/core";
import providerSpecs from "../../../provider_specs/provider-specs.json" with { type: "json" };
import {
  PROVIDER_RECOGNITION_ORDER,
  buildProviderDirectory,
} from "../src/provider-connect.js";

/* A 2.1 provider's row comes from its own switched on spec. The rows of the
   providers that shipped before the wave stay pinned exactly around it. */
const WAVE = new Set(WAVE_PROVIDERS.map((provider) => provider.code.toLowerCase()));
const isWave = (row: { connectorId: string | null }) => WAVE.has(row.connectorId ?? "");

describe("provider connection directory", () => {
  it("keeps one explicit recognition order for all provider surfaces", () => {
    const waveRows = buildProviderDirectory(providerSpecs).filter(isWave);
    for (const row of waveRows) expect(isEnabledProviderCode(String(row.connectorId).toUpperCase()), row.specId).toBe(true);
    const waveIds = new Set(waveRows.map((row) => row.specId));
    expect(PROVIDER_RECOGNITION_ORDER.filter((id) => !waveIds.has(id))).toEqual([
      "openai/codex",
      "anthropic/claude-code",
      "google/gemini-cli",
      "google/antigravity",
      "xai/api",
      "moonshot/api",
      "opencode/opencode",
      "openrouter/api",
      "cursor/editor",
    ]);
  });

  it("shows only the nine providers with collecting connectors", () => {
    const all = buildProviderDirectory(providerSpecs);
    const rows = all.filter((row) => !isWave(row));

    expect(rows).toHaveLength(9);
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
        "Cursor",
      ]);
    expect(all.some((row) => row.availability === "planned")).toBe(false);
    expect(all.some((row) => row.connectorId === "manual")).toBe(false);
  });

  it("classifies the nine collecting providers by their real access path", () => {
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

  it("keeps every required connection state distinct across all nine rows", () => {
    const rows = buildProviderDirectory(providerSpecs, {
      states: {
        claude: "CONNECTED",
        codex: "NEEDS_AUTH",
        "gemini-cli": "DEGRADED",
        antigravity: "STALE",
      },
    });
    const byConnector = new Map(rows.map((row) => [row.connectorId, row]));

    expect(rows.filter((row) => !isWave(row))).toHaveLength(9);
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
