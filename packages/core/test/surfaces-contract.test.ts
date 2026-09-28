import { describe, expect, it } from "vitest";
import { SNAPSHOT_AVAILABILITIES } from "../src/connection-state.js";
import { isSurfaceAccountRow, traySummary, usageBand, type SurfaceAccountRow } from "../src/contracts/surfaces.js";

const row = (changes: Partial<SurfaceAccountRow> = {}): SurfaceAccountRow => ({
  provider: "CLAUDE", account: null, headlineMeterId: "five-hour", kind: "quota_percent", value: 20,
  meaning: "used", windowLabel: "5 hours", resetAt: "2026-09-28T17:00:00.000Z", freshness: "fresh",
  availability: "available", band: "green", precision: "exact", fidelityMarker: null,
  sessions: { busy: 1, waiting: 0, done: 0, idle: 0, unknown: 0 }, ...changes
});

describe("tray and Rail contracts", () => {
  it.each([[0,"green"], [59,"green"], [59.99,"green"], [60,"yellow"], [79,"yellow"], [79.99,"yellow"],
    [80,"orange"], [89,"orange"], [89.99,"orange"], [90,"red"], [100,"red"]] as const)("%d used is %s", (percent, band) => {
    expect(usageBand(percent)).toBe(band);
    expect(isSurfaceAccountRow(row({ value: percent, band }))).toBe(true);
    expect(isSurfaceAccountRow(row({ value: 100 - percent, meaning: "remaining", band }))).toBe(true);
  });
  it("selects the most consumed fresh quota with its provider, account, window and reset", () => {
    const selected = row({ provider: "CODEX", account: "work", headlineMeterId: "weekly", value: 10, meaning: "remaining",
      band: "red", windowLabel: "7 days", resetAt: "2026-10-01T12:00:00.000Z" });
    const summary = traySummary([row(), selected]);
    expect(summary).toEqual({ state: "numeric", value: 90, meaning: "used", band: "red", selected,
      partial: false, includedRows: 2, excludedRows: 0 });
    expect(summary.selected).toEqual(selected);
    expect(selected.meaning).toBe("remaining");
  });
  it("ties keep selection order and zero is a valid numeric quota", () => {
    const first = row({ account: "first", value: 0 });
    const second = row({ account: "second", value: 0 });
    expect(traySummary([first, second])).toMatchObject({ state: "numeric", value: 0, selected: first });
    expect(traySummary([row({ value: 100, meaning: "remaining" })]).value).toBe(0);
  });
  it.each(["money_balance", "spend", "token_count", "runtime_info", "unknown"] as const)("never folds %s into a percent", (kind) => {
    const other = row({ kind, value: 100000, band: "stale" });
    expect(isSurfaceAccountRow(other)).toBe(true);
    expect(traySummary([other])).toMatchObject({ state: "unknown", value: null });
    expect(traySummary([row(), other])).toMatchObject({ state: "numeric", value: 20, partial: true, excludedRows: 1 });
  });
  it.each(SNAPSHOT_AVAILABILITIES)("never converts %s into a numeric reading", (availability) => {
    const unavailable = row({ availability, value: null, band: "stale" });
    expect(isSurfaceAccountRow(unavailable)).toBe(true);
    expect(traySummary([unavailable])).toMatchObject({ state: "unknown", value: null, includedRows: 0, excludedRows: 1 });
    expect(traySummary([row(), unavailable])).toMatchObject({ partial: true, value: 20 });
    expect(isSurfaceAccountRow({ ...unavailable, value: 0 })).toBe(false);
    expect(traySummary([{ ...unavailable, value: 0 }]).state).toBe("unknown");
  });
  it.each(["stale", "unknown"] as const)("retains %s rows but excludes them from numeric selection", (freshness) => {
    const stale = row({ freshness, band: "stale", value: 99 });
    expect(isSurfaceAccountRow(stale)).toBe(true);
    expect(usageBand(99, freshness)).toBe("stale");
    expect(traySummary([row(), stale])).toMatchObject({ value: 20, partial: true });
    expect(traySummary([stale]).state).toBe("unknown");
  });
  it("has an explicit empty and wholly nonnumeric result", () => {
    expect(traySummary([])).toEqual({ state: "unknown", selected: null, value: null, meaning: "used", band: "stale",
      partial: false, includedRows: 0, excludedRows: 0 });
    expect(traySummary([row({ value: null, band: "stale" })]).state).toBe("unknown");
    for (const value of [NaN, Infinity, -1, 101]) {
      expect(usageBand(value)).toBe("stale");
      expect(traySummary([row({ value })]).state).toBe("unknown");
    }
  });
  it.each(["estimated", "manual", "unknown"] as const)("requires an explicit %s fidelity marker", (precision) => {
    expect(isSurfaceAccountRow(row({ precision, fidelityMarker: precision }))).toBe(true);
    expect(isSurfaceAccountRow(row({ precision, fidelityMarker: null }))).toBe(false);
  });
  it.each([
    { provider: "invalid" }, { account: "" }, { headlineMeterId: "" }, { windowLabel: "" }, { meaning: "percent" },
    { freshness: "recent" }, { availability: "online" }, { kind: "balance" }, { precision: "reported" },
    { resetAt: "2026-02-30T00:00:00.000Z" }, { fidelityMarker: "estimated" }, { band: "red" },
    { path: "private" }, { sessions: { busy: -1, waiting: 0, done: 0, idle: 0, unknown: 0 } },
    { sessions: { busy: 65, waiting: 0, done: 0, idle: 0, unknown: 0 } }, { sessions: {} }
  ])("rejects inconsistent surface model %j", (changes) => {
    expect(isSurfaceAccountRow({ ...row(), ...changes })).toBe(false);
  });
});
