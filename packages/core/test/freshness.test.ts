import { describe, expect, it } from "vitest";
import { freshness } from "../src/index.js";

describe("freshness", () => {
  it("separates fresh and stale values", () => {
    expect(
      freshness(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:05:00.000Z",
        "2026-01-01T00:04:00.000Z"
      )
    ).toBe("fresh");
    expect(
      freshness(
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:05:00.000Z",
        "2026-01-01T00:06:00.000Z"
      )
    ).toBe("stale");
  });

  it("fails closed on invalid chronology", () => {
    expect(freshness("bad", "also bad", "2026-01-01T00:00:00.000Z")).toBe("unknown");
    expect(
      freshness(
        "2026-01-01T01:00:00.000Z",
        "2026-01-01T02:00:00.000Z",
        "2026-01-01T00:00:00.000Z"
      )
    ).toBe("unknown");
  });
});
