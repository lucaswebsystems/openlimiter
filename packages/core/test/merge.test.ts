import { describe, expect, it } from "vitest";
import { MAX_CACHE_ENTRIES, mergeSnapshots } from "../src/index.js";
import { snapshot } from "./helpers.js";

describe("snapshot merge", () => {
  it("replaces one meter and keeps every other meter", () => {
    const existing = [
      snapshot({ meter: "FIVE_HOUR", value: 42 }),
      snapshot({ provider: "MANUAL", meter: "MONTHLY", value: 10 })
    ];
    const merged = mergeSnapshots(existing, [snapshot({ meter: "FIVE_HOUR", value: 61 })]);
    expect(merged).toHaveLength(2);
    expect(merged.find((entry) => entry.meter === "FIVE_HOUR")?.value).toBe(61);
    expect(merged.find((entry) => entry.meter === "MONTHLY")?.value).toBe(10);
  });

  it("orders the result the same way for the same input", () => {
    const first = mergeSnapshots(
      [snapshot({ meter: "SEVEN_DAY" }), snapshot({ meter: "FIVE_HOUR" })],
      []
    );
    const second = mergeSnapshots(
      [snapshot({ meter: "FIVE_HOUR" }), snapshot({ meter: "SEVEN_DAY" })],
      []
    );
    expect(first.map((entry) => entry.meter)).toEqual(second.map((entry) => entry.meter));
  });

  it("stays bounded and keeps the most recently observed rows", () => {
    const existing = Array.from({ length: MAX_CACHE_ENTRIES + 8 }, (_unused, index) =>
      snapshot({
        meter: "METER_" + String(index),
        observedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000)
          .toISOString(),
        expiresAt: new Date(Date.parse("2026-01-01T01:00:00.000Z") + index * 1_000)
          .toISOString()
      }));
    const merged = mergeSnapshots(existing, []);
    expect(merged).toHaveLength(MAX_CACHE_ENTRIES);
    expect(merged.some((entry) => entry.meter === "METER_0")).toBe(false);
    expect(
      merged.some((entry) => entry.meter === "METER_" + String(MAX_CACHE_ENTRIES + 7))
    ).toBe(true);
  });
});
