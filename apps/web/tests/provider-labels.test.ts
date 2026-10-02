import { describe, expect, it } from "vitest";
import { claudeMeterOverride, meterName, providerName } from "../app/app/language";
import { claudeFableHint } from "../app/app/pieces";
import { buildProviderAccountRows, type Snapshot } from "../app/app/engine";

describe("provider labels", () => {
  it("describes Grok's shared weekly pool", () => {
    expect(providerName("GROK")).toBe("Grok weekly usage across Grok products");
  });

  it("uses the shared Claude labels for both Fable versions", () => {
    expect(meterName("FIVE_HOUR", "CLAUDE")).toBe("Current session");
    expect(meterName("SEVEN_DAY", "CLAUDE")).toBe("Weekly, all models");
    expect(meterName("SEVEN_DAY_FABLE_5", "CLAUDE")).toBe("Weekly, Fable");
    expect(meterName("SEVEN_DAY_FABLE_5_1", "CLAUDE")).toBe("Weekly, Fable");
    expect(meterName("SEVEN_DAY_OPUS", "CLAUDE")).toBe("Weekly, Opus");
    expect(meterName("EXTRA_USAGE", "CLAUDE")).toBe("Extra usage");
  });

  it("overrides only Claude and leaves every other provider on shared labels", () => {
    const base: Snapshot = {
      provider: "CODEX",
      meter: "FIVE_HOUR",
      value: 42,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: 18_000 },
      resetAt: null,
      source: "internal_payload",
      precision: "exact",
      observedAt: "2026-10-02T12:00:00.000Z",
      expiresAt: "2026-10-02T12:20:00.000Z",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "internal-endpoint",
        automationRisk: "high",
        verification: "UNVERIFIED",
      },
    };
    const snapshots: Snapshot[] = [
      base,
      { ...base, provider: "OPENROUTER", meter: "CREDITS", unit: "CREDITS", window: { kind: "lifetime" } },
      { ...base, provider: "GEMINI_CLI", meter: "GEMINI_3_1_PRO_PREVIEW" },
      { ...base, provider: "CLAUDE" },
    ];
    const rows = buildProviderAccountRows(snapshots, "2026-10-02T12:01:00.000Z", [], {
      meterLabel: claudeMeterOverride,
    });
    const labels = Object.fromEntries(rows.map((row) => [row.provider, row.windows[0]?.label]));

    expect(labels).toEqual({
      CLAUDE: "Current session",
      OPENROUTER: "Credit spend",
      CODEX: "5 hour session",
      GEMINI_CLI: "Gemini 3.1 Pro Preview",
    });
  });

  it("shows the desktop path only when a Claude card has no model scoped window", () => {
    const hint = "Turn on Show Fable limit in the desktop app under Add a tool, Claude Code.";
    expect(claudeFableHint("CLAUDE", ["FIVE_HOUR", "SEVEN_DAY"], hint)).toBe(hint);
    expect(claudeFableHint("CLAUDE", ["FIVE_HOUR", "SEVEN_DAY_FABLE_5_1"], hint)).toBeNull();
    expect(claudeFableHint("CODEX", ["FIVE_HOUR", "SEVEN_DAY"], hint)).toBeNull();
  });
});
