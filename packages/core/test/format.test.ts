import { describe, expect, it } from "vitest";
import { floorFixed } from "../src/index.js";

describe("honest number rendering", () => {
  it("never rounds a usage value upward", () => {
    expect(floorFixed(99.99, 1)).toBe("99.9");
    expect(floorFixed(79.99, 1)).toBe("79.9");
    expect(floorFixed(99.99, 0)).toBe("99");
    expect(floorFixed(79.99, 0)).toBe("79");
    expect(floorFixed(99.999999, 2)).toBe("99.99");
  });

  it("reports a reached cap exactly", () => {
    expect(floorFixed(100, 1)).toBe("100.0");
    expect(floorFixed(0, 2)).toBe("0.00");
  });

  it("ignores binary floating point noise", () => {
    expect(floorFixed(84.25, 2)).toBe("84.25");
    expect(floorFixed(0.1 + 0.2, 2)).toBe("0.30");
    expect(floorFixed((37 / 100) * 100, 2)).toBe("37.00");
  });

  it("stays bounded for values that are not finite", () => {
    expect(floorFixed(Number.NaN, 2)).toBe("0.00");
    expect(floorFixed(Number.POSITIVE_INFINITY, 1)).toBe("0.0");
  });
});
