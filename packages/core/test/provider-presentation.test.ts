import { describe, expect, it } from "vitest";
import {
  providerMeterLabel,
  providerMeterPresentation,
  providerMeterRank,
} from "../src/index.js";

describe("provider meter presentation", () => {
  it("keeps the affected identities and meanings in one contract", () => {
    expect(providerMeterPresentation("CODEX", "MONTHLY_CREDIT_LIMIT")).toMatchObject({
      defaultLabel: "Monthly credit limit",
      compactLabel: "Monthly",
      order: 40,
      valueSemantics: "used",
      visible: true,
    });
    expect(providerMeterPresentation("CODEX", "CREDITS")).toMatchObject({
      defaultLabel: "Credits",
      compactLabel: "Credits",
      order: 100,
      valueSemantics: "balance",
    });
    expect(providerMeterPresentation("OPENROUTER", "KEY_LIMIT")).toMatchObject({
      defaultLabel: "Key allowance",
      compactLabel: "key",
      valueSemantics: "used",
    });
    expect(providerMeterPresentation("OPENROUTER", "ACCOUNT_BALANCE")).toMatchObject({
      defaultLabel: "Account balance",
      compactLabel: "Balance",
      valueSemantics: "balance",
      displayAvailability: true,
    });
  });

  it("keeps Kimi summary first and labels every percentage as used", () => {
    expect(providerMeterRank("KIMI", "WEEKLY")).toBe(10);
    expect(providerMeterRank("KIMI", "FIVE_HOUR")).toBe(20);
    expect(providerMeterRank("KIMI", "SEVEN_DAY")).toBe(30);
    for (const meter of ["WEEKLY", "FIVE_HOUR", "SEVEN_DAY"]) {
      expect(providerMeterPresentation("KIMI", meter)?.valueSemantics).toBe("used");
    }
    expect(providerMeterPresentation("KIMI", "FIVE_HOUR_2")).toMatchObject({
      defaultLabel: "5 hour limit 2",
      compactLabel: "5h used 2",
      order: 21,
    });
    expect(providerMeterPresentation("KIMI", "FIVE_MINUTE")).toMatchObject({
      defaultLabel: "5 minute limit",
      compactLabel: "5m used",
    });
    expect(providerMeterPresentation("KIMI", "DAILY")).toMatchObject({
      labelKey: "kimiDailyUsed",
      defaultLabel: "Daily limit",
      compactLabel: "1d used",
    });
    expect(providerMeterPresentation("KIMI", "FIVE_HOUR_10")).toMatchObject({
      defaultLabel: "5 hour limit 10",
      compactLabel: "5h used 10",
    });
    expect(providerMeterPresentation("KIMI", "WINDOW_7200_2")).toMatchObject({
      defaultLabel: "2 hour limit 2",
      compactLabel: "2h used 2",
      valueSemantics: "used",
    });
    expect(providerMeterLabel("KIMI", "WINDOW_7200_2", { kimiUsageUsed: "Limite de uso" }))
      .toBe("Limite de uso (2h) 2");
  });

  it("names OpenCode page readings and hides unverified Cursor bars", () => {
    expect(providerMeterPresentation("OPENCODE", "FIVE_HOUR")?.defaultLabel)
      .toBe("5 hour limit, from the OpenCode page");
    for (const meter of ["AUTO", "API", "INCLUDED"]) {
      expect(providerMeterPresentation("CURSOR", meter)?.visible).toBe(false);
    }
  });
});
