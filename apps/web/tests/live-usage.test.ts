// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildProviderAccountRows } from "../app/app/engine";
import { featuredSnapshotOf } from "../app/app/live-meter";
import {
  snapshotsFromSyncedUsage,
  visibleQuotaSnapshots,
} from "../app/app/live-usage";
import type { SyncedProviderUsage } from "../lib/synced-usage";

const NOW = "2026-10-01T12:00:00.000Z";
const IDENTIFIED_CODEX = "codex-f97543643c7f784dcad92da4";
const IDENTIFIED_CLAUDE = "claude-8920457716250c66b205c90d";

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
  it("reproduces the owner screen and keeps only current real quota meters", () => {
    const snapshots = snapshotsFromSyncedUsage(OWNER_SCREEN, NOW, (count) => `Account ${count}`);
    expect(snapshots.map((row) => [row.provider, row.accountId, row.meter, row.value])).toEqual([
      ["CLAUDE", IDENTIFIED_CLAUDE, "FIVE_HOUR", 11],
      ["CLAUDE", IDENTIFIED_CLAUDE, "SEVEN_DAY", 84],
      ["CODEX", IDENTIFIED_CODEX, "SEVEN_DAY", 36],
    ]);
    expect(snapshots.some((row) => row.accountId === "default")).toBe(false);
    expect(snapshots.some((row) => row.meter === "ACQUISITION")).toBe(false);
    expect(featuredSnapshotOf(snapshots)?.value).toBe(84);

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
