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
    expect(rows.map((row) => row.accountLabel)).toEqual(["personal", "work"]);
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
    expect(rows.map((row) => row.accountLabel)).toEqual([
      "Local account",
      "none",
    ]);
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
    expect(markup).toContain("primary");
    expect(markup).toContain("5 hour session");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("63.0%");
    expect(markup).toContain("<svg");
    expect(markup).toContain('d="m4.7144 15.9555');
    expect(markup).not.toContain('d="M12 2v20M2 12h20');
    expect(markup.match(/role=\"progressbar\"/g)).toHaveLength(2);
    expect(markup).not.toContain("mini-window");
    expect(markup).not.toContain("mini-meter");
    expect(markup).not.toContain("metric-session");
    expect(markup).not.toContain("No data");
    expect(markup).toContain('<span class="window-reset">1h 30m</span>');
    expect(markup).toContain('<strong class="window-percent">63.0%</strong>');
    expect(markup).not.toContain('<span class="account-value"');
  });

  it("keeps account identity accessible without rendering an account badge", () => {
    const row = buildProviderAccountRows(
      [snapshot("CODEX", "FIVE_HOUR", 63, "work")],
      NOW,
      [],
      { providers: ["CODEX"] }
    )[0];

    expect(row).toBeDefined();
    const markup = providerRowMarkup(row!);
    expect(markup).toContain('aria-label="Codex, work"');
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
      label: "Weekly",
      usedPercent: 62,
    });
    expect(windowForMetric(row!.windows, "session")).toMatchObject({
      usedPercent: 38,
    });
    expect(windowForMetric(row!.windows, "week")).toMatchObject({
      usedPercent: 62,
    });
    expect(windowForMetric(row!.windows, "month")).toMatchObject({
      usedPercent: 41,
    });
    const markup = providerRowMarkup(row!);
    expect(markup).toContain(">5 hour session</span>");
    expect(markup).toContain(">Weekly</span>");
    expect(markup).toContain(">Monthly</span>");
    expect(markup).toContain(">38.0%</strong>");
    expect(markup).toContain(">62.0%</strong>");
    expect(markup).toContain(">41.0%</strong>");
    expect(markup.match(/role=\"progressbar\"/g)).toHaveLength(3);
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
      "Weekly",
      "Weekly Opus",
      "Weekly Sonnet",
    ]);
    expect(windowForMetric(row?.windows ?? [], "week")).toMatchObject({
      label: "Weekly Opus",
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

  it("labels credit and monthly windows and colors them by remaining headroom", () => {
    const credits: Snapshot = {
      ...snapshot("OPENROUTER", "CREDITS", 62),
      unit: "CREDITS",
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
      label: "Credit spend",
      readout: "$12.47",
      metricKind: "bounded_spend",
      tone: "watch",
    });
    expect(monthlyRow?.windows[0]).toMatchObject({
      label: "Monthly",
      tone: "high",
    });
    expect(headroomTone(91)).toBe("critical");
    expect(headroomTone(20)).toBe("ok");
  });

  it("keeps spend without a ceiling neutral", () => {
    const spend: Snapshot = {
      ...snapshot("OPENROUTER", "CREDITS", 12.47),
      unit: "CREDITS",
    };
    const row = buildProviderAccountRows([spend], NOW, [], {
      providers: ["OPENROUTER"],
    })[0];
    expect(row?.windows[0]).toMatchObject({
      label: "Credit spend",
      readout: "12.47 credits spent",
      metricKind: "unbounded_spend",
      tone: "none",
      usedPercent: null,
    });
    const markup = providerRowMarkup(row!);
    expect(markup).toContain('class="window-meter neutral"');
    expect(markup).not.toContain('role="progressbar"');
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
    expect(
      byProvider.get("KIMI")?.windows.map((window) => window.label)
    ).toEqual(["5 hour session", "Weekly", "5 hour session 2"]);
    expect(
      byProvider.get("GEMINI_CLI")?.windows.map((window) => window.label)
    ).toEqual(["Gemini 3.1 Pro Preview", "Gemini 3 Flash Preview"]);
  });
});
