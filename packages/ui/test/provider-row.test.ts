import { describe, expect, it } from "vitest";
import type { ProviderCode, Snapshot } from "@openlimiter/core";
import {
  buildProviderAccountRows,
  closestToLimit,
  headroomTone,
  providerRowMarkup,
  resetCountdown,
  windowForMetric,
} from "../src/provider-row.js";

const NOW = "2026-08-19T12:00:00.000Z";

function snapshot(
  provider: ProviderCode,
  meter: string,
  value: number,
  accountId?: string,
  resetAt: string | null = null
): Snapshot {
  return {
    provider,
    meter,
    value,
    unit: "PERCENT",
    window: { kind: "rolling" },
    resetAt,
    source: "internal_payload",
    precision: "exact",
    observedAt: NOW,
    expiresAt: "2026-08-19T13:00:00.000Z",
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "internal-endpoint",
      automationRisk: "high",
      verification: "UNVERIFIED",
    },
    ...(accountId === undefined ? {} : { accountId }),
  };
}

describe("provider account rows", () => {
  it("renders a direct OpenRouter dollar balance as dollars", () => {
    const balance = snapshot("OPENROUTER", "ACCOUNT_BALANCE", 12.34, "openrouter");
    balance.unit = "CREDITS";
    balance.window = { kind: "lifetime" };
    balance.kind = "money_balance";
    balance.currency = "USD";
    expect(buildProviderAccountRows([balance], NOW)[0]?.windows[0]).toMatchObject({
      metricKind: "balance",
      readout: "$12.34",
      usedPercent: null,
    });
  });

  it("keeps two accounts as two rows and keeps every returned window", () => {
    const rows = buildProviderAccountRows(
      [
        snapshot("CODEX", "FIVE_HOUR", 73, "work", "2026-08-19T13:30:00.000Z"),
        snapshot("CODEX", "HARD_LIMIT", 88, "work"),
        snapshot("CODEX", "SEVEN_DAY", 41, "personal"),
        snapshot("CODEX", "CUSTOM_BURST", 12, "personal"),
      ],
      NOW,
      [],
      { providers: ["CODEX"] }
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.accountLabel)).toEqual(["Account 1", "Account 2"]);
    expect(rows[0]?.windows.map((window) => window.label)).toEqual([
      "Weekly",
      "Custom burst",
    ]);
    expect(rows[1]?.windows.map((window) => window.label)).toEqual([
      "5 hour session",
      "Hard limit",
    ]);
    expect(rows[1]?.windows[0]?.resetLabel).toBe("Resets in 1h 30m");
    expect(rows[1]?.windows[1]?.resetLabel).toBeNull();
  });

  it("does not merge an unnamed account with an account whose id is none", () => {
    const rows = buildProviderAccountRows(
      [
        snapshot("CODEX", "FIVE_HOUR", 20),
        snapshot("CODEX", "SEVEN_DAY", 40, "none"),
      ],
      NOW,
      [],
      { providers: ["CODEX"] }
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows.map((row) => row.accountLabel)).toEqual(["Account 1", "Account 2"]);
  });

  it("shows no provider until one is explicitly configured", () => {
    expect(buildProviderAccountRows([], NOW)).toEqual([]);
  });

  it("uses explicit fallback states only for configured providers", () => {
    const rows = buildProviderAccountRows([], NOW, [], {
      providers: ["CODEX", "GEMINI_CLI", "GROK", "KIMI"],
    });
    const codex = rows.find((row) => row.provider === "CODEX");
    const gemini = rows.find((row) => row.provider === "GEMINI_CLI");
    const grok = rows.find((row) => row.provider === "GROK");
    const kimi = rows.find((row) => row.provider === "KIMI");

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.provider)).toEqual([
      "CODEX",
      "GEMINI_CLI",
      "GROK",
      "KIMI",
    ]);
    expect(codex?.fallback).toMatchObject({
      kind: "not_found",
      title: "Not connected",
    });
    expect(gemini?.fallback).toMatchObject({
      kind: "not_found",
      title: "Not connected",
    });
    expect(grok?.fallback).toMatchObject({
      kind: "not_found",
      title: "Not connected",
    });
    expect(kimi?.fallback).toMatchObject({
      kind: "not_found",
      title: "Not connected",
    });
    expect(rows.some((row) => row.provider === "MANUAL")).toBe(false);
  });

  it("renders one compact usage line and one bar for every window", () => {
    const row = buildProviderAccountRows(
      [
        snapshot(
          "CLAUDE",
          "FIVE_HOUR",
          63,
          "primary",
          "2026-08-19T13:30:00.000Z"
        ),
        snapshot("CLAUDE", "SEVEN_DAY", 28, "primary"),
      ],
      NOW,
      [],
      { providers: ["CLAUDE"] }
    )[0];

    expect(row).toBeDefined();
    const markup = providerRowMarkup(row!);
    expect(markup).not.toContain("primary");
    expect(markup).toContain("Current session");
    expect(markup).toContain("Weekly, all models");
    expect(markup).toContain("63%");
    expect(markup).toContain('<slot name="actions"></slot>');
    expect(markup).toContain("<svg");
    expect(markup).toContain('d="m4.7144 15.9555');
    expect(markup).not.toContain('d="M12 2v20M2 12h20');
    expect(markup.match(/role=\"progressbar\"/g)).toHaveLength(2);
    expect(markup).not.toContain("mini-window");
    expect(markup).not.toContain("mini-meter");
    expect(markup).not.toContain("metric-session");
    expect(markup).not.toContain("No data");
    expect(markup).toContain('<span class="window-reset">1h 30m</span>');
    expect(markup).toContain('<strong class="window-percent">63%</strong>');
    expect(markup).not.toContain('<span class="account-value"');
  });

  it("omits account identity when a provider has one shown account", () => {
    const row = buildProviderAccountRows(
      [snapshot("CODEX", "FIVE_HOUR", 63, "work")],
      NOW,
      [],
      { providers: ["CODEX"] }
    )[0];

    expect(row).toBeDefined();
    const markup = providerRowMarkup(row!);
    expect(markup).toContain('aria-label="Codex"');
    expect(markup).not.toContain("work");
    expect(markup).not.toContain('<span class="account-value"');
  });

  it("keeps session, week, and month as separate four item lines", () => {
    const row = buildProviderAccountRows(
      [
        snapshot("CLAUDE", "FIVE_HOUR", 38, "primary"),
        snapshot("CLAUDE", "SEVEN_DAY", 62, "primary"),
        snapshot("CLAUDE", "MONTHLY", 41, "primary"),
      ],
      NOW,
      [],
      { providers: ["CLAUDE"] }
    )[0];

    expect(row).toBeDefined();
    expect(closestToLimit(row!.windows)).toMatchObject({
      label: "Weekly, all models",
      usedPercent: 62,
    });
    expect(windowForMetric(row!.windows, "session")).toMatchObject({
      usedPercent: 38,
    });
    expect(windowForMetric(row!.windows, "week")).toMatchObject({
      usedPercent: 62,
    });
    expect(windowForMetric(row!.windows, "month")).toBeNull();
    const markup = providerRowMarkup(row!);
    expect(markup).toContain(">Current session</span>");
    expect(markup).toContain(">Weekly, all models</span>");
    expect(markup).toContain(">38%</strong>");
    expect(markup).toContain(">62%</strong>");
    expect(markup.match(/role=\"progressbar\"/g)).toHaveLength(2);
  });

  it("keeps every Claude model family window as its own line", () => {
    const row = buildProviderAccountRows(
      [
        snapshot("CLAUDE", "SEVEN_DAY", 35, "primary"),
        snapshot("CLAUDE", "SEVEN_DAY_OPUS", 51, "primary"),
        snapshot("CLAUDE", "SEVEN_DAY_SONNET", 27, "primary"),
      ],
      NOW,
      [],
      { providers: ["CLAUDE"] }
    )[0];

    expect(row?.windows.map((window) => window.label)).toEqual([
      "Weekly, all models",
      "Weekly, Opus",
      "Weekly, Sonnet",
    ]);
    expect(windowForMetric(row?.windows ?? [], "week")).toMatchObject({
      label: "Weekly, Opus",
      usedPercent: 51,
    });
  });

  it("does not render a broken looking meter for an unavailable reading", () => {
    const row = buildProviderAccountRows([], NOW, [], {
      providers: ["GROK"],
    })[0];

    expect(row).toBeDefined();
    const markup = providerRowMarkup(row!);
    expect(markup).not.toContain("Not connected");
    expect(markup.match(/role=\"progressbar\"/g)).toBeNull();
    expect(markup).not.toContain("No data");
  });

  it("formats a bounded reset countdown and omits an absent reset", () => {
    expect(resetCountdown(null, NOW)).toBeNull();
    expect(resetCountdown("2026-08-21T14:00:00.000Z", NOW)).toBe(
      "Resets in 2d 2h"
    );
  });

  it("separates OpenRouter account balance from bounded quota pressure", () => {
    const credits: Snapshot = {
      ...snapshot("OPENROUTER", "ACCOUNT_BALANCE", 62),
      usedAmount: 12.47,
      limitAmount: 20,
      currency: "USD",
    };
    const creditRow = buildProviderAccountRows([credits], NOW, [], {
      providers: ["OPENROUTER"],
    })[0];
    const monthlyRow = buildProviderAccountRows(
      [snapshot("MANUAL", "MONTHLY", 80)],
      NOW,
      [],
      { providers: ["MANUAL"] }
    )[0];

    expect(creditRow?.windows[0]).toMatchObject({
      label: "Account balance",
      readout: "$7.53",
      metricKind: "balance",
      tone: "none",
    });
    expect(monthlyRow?.windows[0]).toMatchObject({
      label: "Monthly",
      tone: "high",
    });
    expect(headroomTone(91)).toBe("critical");
    expect(headroomTone(20)).toBe("ok");
  });

  it("shows an uncapped key and a missing management key without numeric bars", () => {
    const spend: Snapshot = {
      ...snapshot("OPENROUTER", "KEY_LIMIT", 0),
      availability: "unlimited",
    };
    const missing: Snapshot = {
      ...snapshot("OPENROUTER", "ACCOUNT_BALANCE", 0),
      availability: "missing_credentials",
    };
    const row = buildProviderAccountRows([spend, missing], NOW, [], {
      providers: ["OPENROUTER"],
    })[0];
    expect(row?.windows[0]).toMatchObject({
      label: "Key allowance",
      readout: "No key cap",
      metricKind: "availability",
      tone: "none",
      usedPercent: null,
    });
    expect(row?.windows[1]).toMatchObject({
      label: "Account balance",
      readout: "Unavailable",
      detail: "A management key is required",
    });
    const markup = providerRowMarkup(row!);
    expect(markup).toContain('class="window-meter neutral"');
    expect(markup).not.toContain('role="progressbar"');
  });

  it("uses Codex copy for unlimited credits and never invents a numeric amount", () => {
    const unlimited: Snapshot = {
      ...snapshot("CODEX", "CREDITS", 0),
      availability: "unlimited",
    };
    const row = buildProviderAccountRows([unlimited], NOW, [], { providers: ["CODEX"] })[0];
    expect(row?.windows[0]).toMatchObject({
      label: "Credits",
      readout: "Unlimited credits",
      detail: "No credit balance limit was reported",
      usedPercent: null,
    });
    expect(providerRowMarkup(row!)).not.toContain("0.00 credits");
  });

  it("labels every Grok, Kimi, and Gemini window after their connectors land", () => {
    const rows = buildProviderAccountRows(
      [
        snapshot("GROK", "WEEKLY", 22, "grok-account"),
        snapshot("GROK", "ON_DEMAND_MONTHLY", 37, "grok-account"),
        snapshot("KIMI", "WEEKLY", 18, "kimi-account"),
        snapshot("KIMI", "FIVE_HOUR", 41, "kimi-account"),
        snapshot("KIMI", "FIVE_HOUR_2", 55, "kimi-account"),
        snapshot("GEMINI_CLI", "GEMINI_3_1_PRO_PREVIEW", 25, "gemini-account"),
        snapshot("GEMINI_CLI", "GEMINI_3_FLASH_PREVIEW", 0, "gemini-account"),
      ],
      NOW,
      [],
      { providers: ["GROK", "KIMI", "GEMINI_CLI"] }
    );
    const byProvider = new Map(rows.map((row) => [row.provider, row]));

    expect(
      byProvider.get("GROK")?.windows.map((window) => window.label)
    ).toEqual(["Weekly", "On demand monthly"]);
    expect(byProvider.get("GROK")?.providerLabel).toBe(
      "Grok weekly usage across Grok products"
    );
    expect(
      byProvider.get("KIMI")?.windows.map((window) => window.label)
    ).toEqual(["Weekly limit", "5 hour limit", "5 hour limit 2"]);
    expect(byProvider.get("KIMI")?.windows.map((window) => window.readout))
      .toEqual(["18% used", "41% used", "55% used"]);
    expect(byProvider.get("KIMI")?.windows.every((window) =>
      window.accessibleLabel.includes("% used"))).toBe(true);
    expect(
      byProvider.get("GEMINI_CLI")?.windows.map((window) => window.label)
    ).toEqual(["Gemini 3.1 Pro Preview", "Gemini 3 Flash Preview"]);
  });

  it("uses Claude's own labels and order for every returned allowance", () => {
    const rows = buildProviderAccountRows(
      [
        snapshot("CLAUDE", "EXTRA_USAGE", 62.35, "claude-account"),
        snapshot("CLAUDE", "MONTHLY", 9, "claude-account"),
        snapshot("CLAUDE", "SEVEN_DAY_SONNET", 12.4, "claude-account"),
        snapshot("CLAUDE", "SEVEN_DAY", 41.2, "claude-account"),
        snapshot("CLAUDE", "SEVEN_DAY_OPUS", 61, "claude-account"),
        snapshot("CLAUDE", "SEVEN_DAY_OAUTH_APPS", 3.1, "claude-account"),
        snapshot("CLAUDE", "SEVEN_DAY_FABLE_5_1", 21.5, "claude-account"),
        snapshot("CLAUDE", "FIVE_HOUR", 23.5, "claude-account"),
      ],
      NOW,
      [],
      { providers: ["CLAUDE"] }
    );
    expect(rows[0]?.windows.map((window) => window.label)).toEqual([
      "Current session",
      "Weekly, all models",
      "Weekly, OAuth Apps",
      "Weekly, Fable",
      "Weekly, Opus",
      "Weekly, Sonnet",
      "Extra usage",
    ]);
  });

  it("keeps the explicit weekly labels this product already shipped", () => {
    const rows = buildProviderAccountRows(
      [
        snapshot("CLAUDE", "SEVEN_DAY_OPUS", 61, "claude-account"),
        snapshot("CLAUDE", "SEVEN_DAY_HAIKU_4_5", 4, "claude-account"),
      ],
      NOW,
      [],
      { providers: ["CLAUDE"] }
    );
    expect(rows[0]?.windows.map((window) => window.label)).toEqual([
      "Weekly, Opus",
      "Weekly, Haiku 4.5",
    ]);
  });

  it("labels the extra usage pool rather than shouting its code", () => {
    const rows = buildProviderAccountRows(
      [snapshot("CLAUDE", "EXTRA_USAGE", 62.35, "claude-account")],
      NOW,
      [],
      { providers: ["CLAUDE"] }
    );
    expect(rows[0]?.windows[0]?.label).toBe("Extra usage");
  });

  it("renders no meter fill at all for a window whose state is unknown", () => {
    /* The fact every stylesheet keying the unknown state on .meter-fill gets
       wrong. A window with no reliable reading has no percentage, so there is
       no fill span to style: the track itself, .window-meter, is the only thing
       there is to draw. Pinned here so an override written against it cannot
       rot silently. */
    const future = "2026-08-19T13:00:00.000Z";
    const rows = buildProviderAccountRows(
      [{ ...snapshot("CLAUDE", "FIVE_HOUR", 42, "claude-account"), observedAt: future }],
      NOW,
      [],
      { providers: ["CLAUDE"] }
    );
    expect(rows[0]?.windows[0]?.state).toBe("unknown");
    expect(rows[0]?.windows[0]?.usedPercent).toBeNull();
    const markup = providerRowMarkup(rows[0]!);
    expect(markup).toContain('data-state="unknown"');
    expect(markup).toContain('class="window-meter"');
    expect(markup).not.toContain("meter-fill");
  });

  it("keeps a safe account label, hides every raw id, and renders a quiet update age", () => {
    const rows = buildProviderAccountRows(
      [
        { ...snapshot("CLAUDE", "FIVE_HOUR", 42, "claude-a"), accountLabel: "Work" },
        { ...snapshot("CLAUDE", "SEVEN_DAY", 52, "claude-b"), accountLabel: "person@example.test" },
      ],
      NOW,
      [],
      {
        providers: ["CLAUDE"],
        accountLabel: (_accountId, count) => `Compte ${count}`,
        updatedLabel: () => "Updated 8 min ago",
      },
    );
    expect(rows.map((row) => row.accountLabel)).toEqual(["Work", "Compte 2"]);
    const markup = rows.map(providerRowMarkup).join("");
    expect(markup).not.toContain("claude-a");
    expect(markup).not.toContain("claude-b");
    expect(markup).not.toContain("person@example.test");
    expect(markup).toContain("Updated 8 min ago");
    expect(markup).toContain(
      '<span class="window-name" title="Current session">Current session<small class="window-updated">Updated 8 min ago</small></span>',
    );
    expect(markup).not.toContain('title="Current session<small');
  });
});
