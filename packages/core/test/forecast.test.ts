import { describe, expect, it } from "vitest";
import { forecast } from "../src/index.js";
import { snapshot } from "./helpers.js";

describe("forecast", () => {
  it("computes burn and exhaustion time", () => {
    const result = forecast(
      snapshot({ value: 20, observedAt: "2026-01-01T00:00:00.000Z" }),
      snapshot({ value: 30, observedAt: "2026-01-01T02:00:00.000Z" })
    );
    expect(result).toEqual({ burnRatePerHour: 5, hoursToExhaustion: 14 });
  });

  it("fails closed when observations do not form a burn rate", () => {
    expect(forecast(snapshot({ value: 30 }), snapshot({ value: 20 }))).toBeNull();
    expect(
      forecast(snapshot(), snapshot({ provider: "CODEX" }))
    ).toBeNull();
    expect(forecast(snapshot(), snapshot({ value: 9e300 }))).toBeNull();
  });
});
