// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProviderAccountRows } from "../app/app/engine";
import { normalizeMeters } from "../app/app/engine/generated/core";
import {
  parseClaudePayload,
  parseGeminiCliPayload,
  parseKimiPayload,
  parseOpenrouterPayload,
} from "../app/app/engine/generated/connectors";
import {
  snapshotsFromSyncedUsage,
  visibleQuotaSnapshots,
} from "../app/app/live-usage";
import type { SyncedProviderUsage } from "../lib/synced-usage";

const NOW = "2026-10-01T12:00:00.000Z";
const IDENTIFIED_CODEX = "codex-f97543643c7f784dcad92da4";
const IDENTIFIED_CLAUDE = "claude-8920457716250c66b205c90d";

function connectorFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(
    path.join(process.cwd(), "..", "..", "packages", "connectors", "fixtures", name),
    "utf8",
  )) as Record<string, unknown>;
}

function provider(
  name: string,
  accountId: string,
  windows: SyncedProviderUsage["windows"],
  accountLabel: string | null = null,
): SyncedProviderUsage {
  return { provider: name, accountId, accountLabel, windows };
}

const OWNER_SCREEN: readonly SyncedProviderUsage[] = [
  provider("CODEX", "legacy-hero", [
    { windowName: "SEVEN_DAY", percentage: 97, resetAt: null, observedAt: "2026-10-01T08:00:00.000Z", stale: true },
  ]),
  provider("CODEX", IDENTIFIED_CODEX, [
    { windowName: "SEVEN_DAY", percentage: 36, resetAt: "2026-10-05T12:00:00.000Z", observedAt: "2026-10-01T09:00:00.000Z", stale: false },
  ]),
  provider("CODEX", "default", [
    { windowName: "SEVEN_DAY", percentage: 95, resetAt: "2026-10-05T12:00:00.000Z", observedAt: "2026-10-01T08:00:00.000Z", stale: true },
  ]),
  provider("CLAUDE", IDENTIFIED_CLAUDE, [
    { windowName: "FIVE_HOUR", percentage: 11, resetAt: "2026-10-01T14:00:00.000Z", observedAt: "2026-10-01T11:54:00.000Z", stale: false },
    { windowName: "SEVEN_DAY", percentage: 84, resetAt: "2026-10-06T09:00:00.000Z", observedAt: "2026-10-01T11:54:00.000Z", stale: false },
    { windowName: "SEVEN_DAY_FABLE", percentage: 57, resetAt: null, observedAt: "2026-10-01T08:00:00.000Z", stale: true },
    { windowName: "ACQUISITION", percentage: 0, resetAt: null, observedAt: "2026-10-01T11:59:00.000Z", stale: false },
  ]),
  provider("CLAUDE", "default", [
    { windowName: "FIVE_HOUR", percentage: 2, resetAt: "2026-10-01T14:00:00.000Z", observedAt: "2026-10-01T08:00:00.000Z", stale: true },
    { windowName: "SEVEN_DAY", percentage: 80, resetAt: "2026-10-06T09:00:00.000Z", observedAt: "2026-10-01T08:00:00.000Z", stale: true },
  ]),
];

describe("live synced usage", () => {
  it("shows every percentage meter emitted from the connector fixture families", () => {
    const connectorNow = "2026-08-07T12:00:00.000Z";
    const claude = connectorFixture("claude.usage.json");
    const claudeMeters = parseClaudePayload({
      ...claude,
      five_hour_2: claude.five_hour,
    }, connectorNow) ?? [];

    const kimi = connectorFixture("kimi.usages.json");
    const originalLimits = kimi.limits as Record<string, unknown>[];
    const originalLimit = originalLimits[0] ?? {};
    const originalDetail = originalLimit.detail as Record<string, unknown>;
    const kimiMeters = parseKimiPayload({
      ...kimi,
      limits: [
        ...originalLimits,
        {
          window: { duration: 1, timeUnit: "TIME_UNIT_DAY" },
          detail: { ...originalDetail, resetTime: "2026-08-08T12:00:00.000Z" },
        },
        {
          window: { duration: 5, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { ...originalDetail, resetTime: "2026-08-07T12:05:00.000Z" },
        },
        originalLimit,
      ],
    }, connectorNow) ?? [];

    const snapshots = normalizeMeters([
      ...(parseOpenrouterPayload(connectorFixture("openrouter.credits.json"), connectorNow) ?? []),
      ...(parseGeminiCliPayload(connectorFixture("gemini-cli.quota.json"), connectorNow) ?? []),
      ...claudeMeters,
      ...kimiMeters,
    ]);
    const visible = visibleQuotaSnapshots(snapshots, connectorNow);
    const meters = new Set(visible.map((row) => `${row.provider}:${row.meter}`));

    expect(meters).toEqual(new Set([
      "OPENROUTER:ACCOUNT_BALANCE",
      "GEMINI_CLI:GEMINI_3_1_PRO_PREVIEW",
      "GEMINI_CLI:GEMINI_3_FLASH_PREVIEW",
      "CLAUDE:FIVE_HOUR",
      "CLAUDE:SEVEN_DAY",
      "CLAUDE:SEVEN_DAY_OAUTH_APPS",
      "CLAUDE:EXTRA_USAGE",
      "CLAUDE:SEVEN_DAY_OPUS",
      "CLAUDE:SEVEN_DAY_FABLE_5_1",
      "KIMI:WEEKLY",
      "KIMI:FIVE_HOUR",
      "KIMI:DAILY",
      "KIMI:FIVE_MINUTE",
      "KIMI:FIVE_HOUR_2",
    ]));
    expect(visible.find((row) => row.provider === "OPENROUTER")?.expiresAt)
      .toBe("2026-08-07T12:07:00.000Z");
  });

  it("excludes placeholders, runtime information, and non percentage rows by semantics", () => {
    const base = normalizeMeters(
      parseOpenrouterPayload(connectorFixture("openrouter.credits.json"), NOW) ?? [],
    )[0];
    expect(base).toBeDefined();
    if (base === undefined) return;

    expect(visibleQuotaSnapshots([
      { ...base, meter: "DIAGNOSTIC", kind: "runtime_info" },
      { ...base, meter: "ACQUISITION" },
      { ...base, meter: "API_BUDGET_PERCENT" },
      { ...base, meter: "UNLIMITED", availability: "unlimited" },
      { ...base, meter: "TOKEN_BALANCE", unit: "TOKENS" },
    ], NOW)).toEqual([]);
  });

  it("applies presentation visibility and value semantics at the web boundary", () => {
    const labels = {
      credentialOrigin: "user-key" as const,
      dataInterfaceStatus: "documented-api" as const,
      automationRisk: "low" as const,
      verification: "UNVERIFIED" as const,
    };
    const base = {
      value: 0,
      unit: "PERCENT" as const,
      window: { kind: "lifetime" as const },
      resetAt: null,
      source: "documented_api" as const,
      precision: "exact" as const,
      observedAt: NOW,
      expiresAt: "2026-10-01T12:07:00.000Z",
      labels,
    };
    const visible = visibleQuotaSnapshots([
      { ...base, provider: "CURSOR", meter: "AUTO", value: 55 },
      { ...base, provider: "CODEX", meter: "CREDITS", unit: "CREDITS", value: 0.25 },
      { ...base, provider: "OPENROUTER", meter: "KEY_LIMIT", availability: "unlimited" },
      { ...base, provider: "OPENROUTER", meter: "ACCOUNT_BALANCE", availability: "missing_credentials" },
    ], NOW);
    expect(visible.map((row) => `${row.provider}:${row.meter}`)).toEqual([
      "CODEX:CREDITS",
      "OPENROUTER:ACCOUNT_BALANCE",
      "OPENROUTER:KEY_LIMIT",
    ]);
  });

  it("projects a synced OpenRouter balance without turning it back into a percentage", () => {
    const snapshots = snapshotsFromSyncedUsage([provider("OPENROUTER", "openrouter-account", [{
      windowName: "ACCOUNT_BALANCE",
      percentage: null,
      amount: 12.34,
      currency: "USD",
      kind: "money_balance",
      resetAt: null,
      observedAt: NOW,
      stale: false,
    }])], NOW);
    expect(snapshots[0]).toMatchObject({
      meter: "ACCOUNT_BALANCE",
      unit: "CREDITS",
      value: 12.34,
      kind: "money_balance",
      currency: "USD",
    });
    expect(buildProviderAccountRows(snapshots, NOW)[0]?.windows[0]).toMatchObject({
      readout: "$12.34",
      metricKind: "balance",
    });
  });

  it("reproduces the owner screen and keeps only current real quota meters", () => {
    const snapshots = snapshotsFromSyncedUsage(OWNER_SCREEN, NOW, (count) => `Account ${count}`);
    expect(snapshots.map((row) => [row.provider, row.accountId, row.meter, row.value])).toEqual([
      ["CLAUDE", IDENTIFIED_CLAUDE, "FIVE_HOUR", 11],
      ["CLAUDE", IDENTIFIED_CLAUDE, "SEVEN_DAY", 84],
      ["CODEX", IDENTIFIED_CODEX, "SEVEN_DAY", 36],
    ]);
    expect(snapshots.some((row) => row.accountId === "default")).toBe(false);
    expect(snapshots.some((row) => row.meter === "ACQUISITION")).toBe(false);
    expect(Math.max(...snapshots.map((row) => row.value))).toBe(84);

    const rows = buildProviderAccountRows(snapshots, NOW);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.showAccountLabel === false)).toBe(true);
    expect(rows.map((row) => row.accountLabel)).not.toContain(IDENTIFIED_CODEX);
    expect(rows.map((row) => row.accountLabel)).not.toContain(IDENTIFIED_CLAUDE);
  });

  it("keeps a model weekly meter only inside its current window", () => {
    const current = provider("CLAUDE", IDENTIFIED_CLAUDE, [{
      windowName: "SEVEN_DAY_FABLE",
      percentage: 57,
      resetAt: null,
      observedAt: "2026-10-01T11:50:00.000Z",
      stale: false,
    }]);
    expect(snapshotsFromSyncedUsage([current], NOW, (count) => `Account ${count}`))
      .toHaveLength(1);
    expect(snapshotsFromSyncedUsage(OWNER_SCREEN, NOW, (count) => `Account ${count}`)
      .some((row) => row.meter === "SEVEN_DAY_FABLE")).toBe(false);
  });

  it("uses the reset boundary when present and the provider refresh horizon otherwise", () => {
    const rows = snapshotsFromSyncedUsage([
      provider("CODEX", "codex-account", [
        { windowName: "SEVEN_DAY", percentage: 44, resetAt: "2026-10-01T12:01:00.000Z", observedAt: "2026-09-30T12:00:00.000Z", stale: true },
        { windowName: "FIVE_HOUR", percentage: 22, resetAt: null, observedAt: "2026-10-01T11:53:01.000Z", stale: false },
      ]),
      provider("CLAUDE", "claude-account", [
        { windowName: "FIVE_HOUR", percentage: 33, resetAt: null, observedAt: "2026-10-01T11:41:01.000Z", stale: false },
      ]),
    ], NOW, (count) => `Account ${count}`);
    expect(rows.map((row) => [row.provider, row.meter])).toEqual([
      ["CLAUDE", "FIVE_HOUR"],
      ["CODEX", "FIVE_HOUR"],
      ["CODEX", "SEVEN_DAY"],
    ]);

    const expired = rows.map((row) => row.provider === "CODEX" && row.meter === "FIVE_HOUR"
      ? { ...row, observedAt: "2026-10-01T11:52:59.000Z", expiresAt: "2026-10-01T11:59:59.000Z" }
      : row);
    expect(visibleQuotaSnapshots(expired, NOW).some((row) => row.provider === "CODEX" && row.meter === "FIVE_HOUR"))
      .toBe(false);
  });

  it("keeps a quiet provider's last reading on the phone, stale, for seven days instead of dropping its card", () => {
    // The founder's phone: Antigravity's status line wrote a day ago and its CLI is closed since.
    const quiet = (observedAt: string) => provider("ANTIGRAVITY", "antigravity-account", [
      { windowName: "FIVE_HOUR", percentage: 40, resetAt: "2026-09-30T15:00:00.000Z", observedAt, stale: true },
    ]);
    const day = snapshotsFromSyncedUsage([quiet("2026-09-30T12:00:00.000Z")], NOW);
    expect(day.map((row) => [row.provider, row.meter, row.value])).toEqual([["ANTIGRAVITY", "FIVE_HOUR", 40]]);
    const rows = buildProviderAccountRows(day, NOW, [], { updatedLabel: () => "Updated 1 d ago" });
    expect(rows[0]?.windows.map((window) => [window.state, window.readout, window.updatedLabel]))
      .toEqual([["stale", "40%", "Updated 1 d ago"]]);
    expect(snapshotsFromSyncedUsage([quiet("2026-09-24T11:59:59.000Z")], NOW)).toEqual([]);
  });

  it("uses safe carried labels and stable translated ordinal fallbacks for several accounts", () => {
    const readings = [
      provider("CLAUDE", "claude-b", [{ windowName: "SEVEN_DAY", percentage: 20, resetAt: "2026-10-02T12:00:00.000Z", observedAt: NOW, stale: false }], "person@example.test"),
      provider("CLAUDE", "claude-a", [{ windowName: "SEVEN_DAY", percentage: 10, resetAt: "2026-10-02T12:00:00.000Z", observedAt: NOW, stale: false }], "Work"),
    ];
    const snapshots = snapshotsFromSyncedUsage(readings, NOW, (count) => `Compte ${count}`);
    const rows = buildProviderAccountRows(snapshots, NOW);
    expect(rows.map((row) => [row.accountId, row.accountLabel, row.showAccountLabel])).toEqual([
      ["claude-a", "Work", true],
      ["claude-b", "Compte 2", true],
    ]);
  });
});
