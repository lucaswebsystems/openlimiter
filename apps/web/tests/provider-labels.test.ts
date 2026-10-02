import { describe, expect, it } from "vitest";
import { meterName, providerName } from "../app/app/language";
import { claudeFableHint } from "../app/app/pieces";

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

  it("shows the desktop path only when a Claude card has no model scoped window", () => {
    const hint = "Turn on Show Fable limit in the desktop app under Add a tool, Claude Code.";
    expect(claudeFableHint("CLAUDE", ["FIVE_HOUR", "SEVEN_DAY"], hint)).toBe(hint);
    expect(claudeFableHint("CLAUDE", ["FIVE_HOUR", "SEVEN_DAY_FABLE_5_1"], hint)).toBeNull();
    expect(claudeFableHint("CODEX", ["FIVE_HOUR", "SEVEN_DAY"], hint)).toBeNull();
  });
});
