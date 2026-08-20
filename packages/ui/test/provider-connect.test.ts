import { describe, expect, it } from "vitest";
import providerSpecs from "../../../provider_specs/provider-specs.json" with { type: "json" };
import { buildProviderDirectory } from "../src/provider-connect.js";

describe("provider connection directory", () => {
  it("promotes arriving CLI connectors without duplicating the expansion rows", () => {
    const rows = buildProviderDirectory(providerSpecs);

    expect(rows).toHaveLength(18);
    expect(rows.filter((row) => row.availability === "ready").map((row) => row.displayName))
      .toEqual([
        "Claude Code",
        "Codex",
        "Grok (xAI)",
        "Kimi",
        "OpenRouter",
        "Antigravity",
        "OpenCode",
        "Manual",
      ]);
    expect(rows.filter((row) => row.availability === "planned").map((row) => row.displayName))
      .toEqual([
        "Perplexity",
        "Gemini CLI",
        "GitHub Copilot",
        "Cursor",
        "Devin Desktop",
        "Ollama",
        "LM Studio",
        "Together",
        "Mistral",
        "DeepSeek",
      ]);
  });

  it("classifies automatic, key, and manual access without treating planned as broken", () => {
    const byId = new Map(buildProviderDirectory(providerSpecs).map((row) => [row.specId, row]));

    expect(byId.get("anthropic/claude-code")?.access).toBe("automatic");
    expect(byId.get("openrouter/api")?.access).toBe("key");
    expect(byId.get("openlimiter/manual")?.access).toBe("manual");
    expect(byId.get("xai/api")?.access).toBe("automatic");
    expect(byId.get("moonshot/api")?.access).toBe("automatic");
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
});
