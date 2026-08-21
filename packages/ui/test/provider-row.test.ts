import { describe, expect, it } from "vitest";
import type { ProviderCode, Snapshot } from "@openlimiter/core";
import {
  buildProviderAccountRows,
  closestToLimit,
  headroomTone,
  providerRowMarkup,
  providerTableHeaderMarkup,
  resetCountdown,
  windowForMetric,
} from "../src/provider-row.js";

const NOW = "2026-08-19T12:00:00.000Z";

function snapshot(
  provider: ProviderCode,
  meter: string,
  value: number,
  accountId?: string,
  resetAt: string | null = null,
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
      { providers: ["CODEX"] },
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
      { providers: ["CODEX"] },
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(rows.map((row) => row.accountLabel)).toEqual(["Local account", "none"]);
  });

  it("uses explicit fallback states when no reading exists", () => {
    const rows = buildProviderAccountRows([], NOW);
    const codex = rows.find((row) => row.provider === "CODEX");
    const gemini = rows.find((row) => row.provider === "GEMINI_CLI");
    const grok = rows.find((row) => row.provider === "GROK");
    const kimi = rows.find((row) => row.provider === "KIMI");
    const manual = rows.find((row) => row.provider === "MANUAL");

    expect(rows).toHaveLength(9);
    expect(rows.map((row) => row.provider)).toEqual([
      "CODEX",
      "CLAUDE",
      "GEMINI_CLI",
      "ANTIGRAVITY",
      "GROK",
      "KIMI",
      "OPENCODE",
      "OPENROUTER",
      "MANUAL",
    ]);
    expect(codex?.fallback).toMatchObject({ kind: "not_found", title: "Not connected" });
    expect(gemini?.fallback).toMatchObject({ kind: "not_found", title: "Not connected" });
    expect(grok?.fallback).toMatchObject({ kind: "not_found", title: "Not connected" });
    expect(kimi?.fallback).toMatchObject({ kind: "not_found", title: "Not connected" });
    expect(manual?.fallback).toMatchObject({
      kind: "manual_entry",
      title: "Manual entry",
    });
  });

  it("renders an aligned row with exactly one usage bar", () => {
    const row = buildProviderAccountRows(
      [
        snapshot("CLAUDE", "FIVE_HOUR", 63, "primary", "2026-08-19T13:30:00.000Z"),
        snapshot("CLAUDE", "SEVEN_DAY", 28, "primary"),
      ],
      NOW,
      [],
      { providers: ["CLAUDE"] },
    )[0];

    expect(row).toBeDefined();
    const markup = providerRowMarkup(row!);
    expect(markup).toContain("primary");
    expect(markup).toContain("5 hour session");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("63.0%");
    expect(markup).toContain("37.0% free");
    expect(markup).toContain("<svg");
    expect(markup).toContain("Live");
    expect(markup.match(/role=\"progressbar\"/g)).toHaveLength(1);
    expect(markup).not.toContain("mini-window");
    expect(markup).not.toContain("mini-meter");
    expect(markup).toContain("metric-session");
    expect(markup).toContain("metric-week");
    expect(markup).toContain("metric-month metric-empty");
    expect(markup).toContain(">1h 30m</span>");
    expect(markup).toContain("hero-readout\">63.0%");
  });

  it("promotes the closest window once and keeps session, week, and month aligned", () => {
    const row = buildProviderAccountRows(
      [
        snapshot("CLAUDE", "FIVE_HOUR", 38, "primary"),
        snapshot("CLAUDE", "SEVEN_DAY", 62, "primary"),
        snapshot("CLAUDE", "MONTHLY", 41, "primary"),
      ],
      NOW,
      [],
      { providers: ["CLAUDE"] },
    )[0];

    expect(row).toBeDefined();
    expect(closestToLimit(row!.windows)).toMatchObject({ label: "Weekly", usedPercent: 62 });
    expect(windowForMetric(row!.windows, "session")).toMatchObject({ usedPercent: 38 });
    expect(windowForMetric(row!.windows, "week")).toMatchObject({ usedPercent: 62 });
    expect(windowForMetric(row!.windows, "month")).toMatchObject({ usedPercent: 41 });
    const markup = providerRowMarkup(row!);
    expect(markup).toContain("hero-readout\">62.0%");
    expect(markup).toContain("metric-session\" aria-label=\"Session, 38.0%\"");
    expect(markup).toContain("metric-week\" aria-label=\"Week, 62.0%\"");
    expect(markup).toContain("metric-month\" aria-label=\"Month, 41.0%\"");
    expect(markup.match(/role=\"progressbar\"/g)).toHaveLength(1);
  });

  it("keeps Claude model family windows in the weekly column", () => {
    const row = buildProviderAccountRows(
      [
        snapshot("CLAUDE", "SEVEN_DAY", 35, "primary"),
        snapshot("CLAUDE", "SEVEN_DAY_OPUS", 51, "primary"),
        snapshot("CLAUDE", "SEVEN_DAY_SONNET", 27, "primary"),
      ],
      NOW,
      [],
      { providers: ["CLAUDE"] },
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

  it("renders the shared column headings once", () => {
    const markup = providerTableHeaderMarkup();

    for (const heading of ["Usage", "Session", "Week", "Month", "Resets"]) {
      expect(markup.match(new RegExp(">" + heading + "<", "g"))).toHaveLength(1);
    }
  });

  it("keeps a quiet placeholder and one empty bar for unavailable readings", () => {
    const row = buildProviderAccountRows([], NOW, [], { providers: ["GROK"] })[0];

    expect(row).toBeDefined();
    const markup = providerRowMarkup(row!);
    expect(markup).toContain("Not connected");
    expect(markup.match(/role=\"progressbar\"/g)).toHaveLength(1);
    expect(markup.match(/metric-empty/g)).toHaveLength(3);
    expect(markup).toContain(">ready</span>");
  });

  it("formats a bounded reset countdown and omits an absent reset", () => {
    expect(resetCountdown(null, NOW)).toBeNull();
    expect(resetCountdown("2026-08-21T14:00:00.000Z", NOW)).toBe("Resets in 2d 2h");
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
      { providers: ["MANUAL"] },
    )[0];

    expect(creditRow?.windows[0]).toMatchObject({
      label: "Credits",
      readout: "$12.47",
      tone: "watch",
    });
    expect(monthlyRow?.windows[0]).toMatchObject({ label: "Monthly", tone: "high" });
    expect(headroomTone(91)).toBe("critical");
    expect(headroomTone(20)).toBe("ok");
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
      { providers: ["GROK", "KIMI", "GEMINI_CLI"] },
    );
    const byProvider = new Map(rows.map((row) => [row.provider, row]));

    expect(byProvider.get("GROK")?.windows.map((window) => window.label)).toEqual([
      "Weekly",
      "On demand monthly",
    ]);
    expect(byProvider.get("KIMI")?.windows.map((window) => window.label)).toEqual([
      "5 hour session",
      "Weekly",
      "5 hour session 2",
    ]);
    expect(byProvider.get("GEMINI_CLI")?.windows.map((window) => window.label)).toEqual([
      "Gemini 3.1 Pro Preview",
      "Gemini 3 Flash Preview",
    ]);
  });
});
