import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDeviceSession,
  deviceSessionNeedsRefresh,
  deviceSessionOf,
  deviceSessionUsable,
  readDeviceSession,
  readDeviceToken,
  writeDeviceSession,
  type DeviceSession,
} from "@/lib/device-session";
import {
  amountRows,
  formatAmount,
  meterRowOf,
  meterRowsOf,
  snapshotFromMeterRow,
} from "@/lib/device-snapshots";

/**
 * What the paired phone keeps, and what it is allowed to believe.
 *
 * Two rules are worth a test each. A device session lives in local storage and
 * never in a cookie, because a cookie would ride on every request this origin
 * makes. And a meter row is either a percentage the engine can draw or money
 * that stays money: nothing here converts a balance into a percentage to make
 * a bar look full.
 */

const SESSION: DeviceSession = {
  token: "signed.phone.token",
  refreshAfter: 1_800,
  expiresAt: 3_600,
  graceUntil: 7_200,
  planState: "active",
  features: ["history"],
  interval: "monthly",
};

const ENGINE_PROVIDERS = ["CLAUDE", "OPENROUTER", "CODEX"];

describe("deviceSessionOf", () => {
  it("reads the one delivery the poll returns", () => {
    const session = deviceSessionOf({
      status: "approved",
      device_token: "signed.phone.token",
      refresh: { after: 1_800, expires_at: 3_600, grace_until: 7_200 },
      entitlement_summary: { plan_state: "active", features: ["history"], interval: "monthly" },
    });
    expect(session).toEqual(SESSION);
  });

  it("refuses anything that is not an approval with usable material", () => {
    expect(deviceSessionOf({ status: "pending" })).toBeNull();
    expect(deviceSessionOf({ status: "approved", device_token: "x" })).toBeNull();
    expect(deviceSessionOf(null)).toBeNull();
  });
});

describe("the store", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps the session in local storage and out of the cookie jar", () => {
    writeDeviceSession(SESSION);
    expect(readDeviceSession()).toEqual(SESSION);
    expect(readDeviceToken()).toBe("signed.phone.token");
    expect(document.cookie).toBe("");
  });

  it("clears on request, which is what a 401 does", () => {
    writeDeviceSession(SESSION);
    clearDeviceSession();
    expect(readDeviceSession()).toBeNull();
    expect(readDeviceToken()).toBeNull();
  });

  it("returns nothing rather than throwing on a store somebody edited", () => {
    window.localStorage.setItem("openlimiter-device-session", "{not json");
    expect(readDeviceSession()).toBeNull();
    window.localStorage.setItem("openlimiter-device-session", JSON.stringify({ token: "" }));
    expect(readDeviceSession()).toBeNull();
  });
});

describe("when a session is still worth sending", () => {
  it("is usable until its grace ends, and needs a refresh once its refresh time passes", () => {
    const now = 1_000 * 1_000;
    const session = { ...SESSION, refreshAfter: 900, expiresAt: 1_100, graceUntil: 1_200 };
    expect(deviceSessionUsable(session, now)).toBe(true);
    expect(deviceSessionNeedsRefresh(session, now)).toBe(true);
    expect(deviceSessionUsable(session, 1_300 * 1_000)).toBe(false);
    expect(deviceSessionUsable(null, now)).toBe(false);
    expect(deviceSessionNeedsRefresh(null, now)).toBe(false);
  });
});

describe("meter contract v2", () => {
  const percentRow = {
    account_id: "work",
    provider: "CLAUDE",
    code: "SEVEN_DAY_OPUS",
    percent: 82.5,
    amount: null,
    currency: null,
    resets_at: "2026-09-08T00:00:00.000Z",
    observed_at: "2026-09-04T11:55:00.000Z",
    stale: false,
  };
  const balanceRow = {
    account_id: "moonshot",
    provider: "MOONSHOT",
    code: "BALANCE_AVAILABLE",
    percent: null,
    amount: 15,
    currency: "CNY",
    resets_at: null,
    observed_at: "2026-09-04T11:55:00.000Z",
    stale: true,
  };

  it("accepts a row with a percentage and a row with only money", () => {
    expect(meterRowOf(percentRow)).toMatchObject({ percent: 82.5, amount: null });
    expect(meterRowOf(balanceRow)).toMatchObject({ amount: 15, currency: "CNY", stale: true });
  });

  it("refuses a row with neither, and money with no currency beside it", () => {
    expect(meterRowOf({ ...percentRow, percent: null })).toBeNull();
    expect(meterRowOf({ ...balanceRow, currency: null })).toBeNull();
    expect(meterRowOf({ ...percentRow, observed_at: "whenever" })).toBeNull();
    expect(meterRowOf({ ...percentRow, account_id: "Work Account" })).toBeNull();
  });

  it("reads a whole response and drops only the rows that fail", () => {
    const rows = meterRowsOf({ schema_version: 2, rows: [percentRow, balanceRow, { junk: true }] });
    expect(rows).toHaveLength(2);
    expect(meterRowsOf(null)).toEqual([]);
  });

  it("sends percentages to the engine and keeps money out of it", () => {
    const rows = meterRowsOf({ rows: [percentRow, balanceRow] });
    const money = amountRows(rows, ENGINE_PROVIDERS);
    expect(money).toHaveLength(1);
    expect(money[0].code).toBe("BALANCE_AVAILABLE");
  });

  it("turns a fresh percentage into a snapshot that has not expired yet", () => {
    const snapshot = snapshotFromMeterRow(meterRowOf(percentRow)!)!;
    expect(snapshot.provider).toBe("CLAUDE");
    expect(snapshot.value).toBe(82.5);
    expect(Date.parse(snapshot.expiresAt as string)).toBeGreaterThan(
      Date.parse(snapshot.observedAt as string),
    );
  });

  it("expires a stale row at its own observation, which is what draws the hatch", () => {
    const row = meterRowOf({ ...percentRow, stale: true })!;
    const snapshot = snapshotFromMeterRow(row)!;
    expect(snapshot.expiresAt).toBe(snapshot.observedAt);
  });

  it("has no snapshot to make from a row with no percentage", () => {
    expect(snapshotFromMeterRow(meterRowOf(balanceRow)!)).toBeNull();
  });

  it("formats an amount in the currency the provider stated", () => {
    const formatted = formatAmount(meterRowOf(balanceRow)!, "en");
    expect(formatted).not.toBeNull();
    expect(formatted).toContain("15");
    expect(formatAmount(meterRowOf(percentRow)!, "en")).toBeNull();
  });
});
