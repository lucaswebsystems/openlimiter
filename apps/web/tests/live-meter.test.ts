// @vitest-environment node
import { describe, expect, it } from "vitest";
import { featuredSnapshotOf } from "../app/app/live-meter";
import type { Snapshot } from "../app/app/engine";

const reading = (provider: string, value: number) => ({ provider, meter: "FIVE_HOUR", unit: "PERCENT", value }) as unknown as Snapshot;

describe("live meter", () => {
  it("features the tightest window, not the first one listed", () => {
    const featured = featuredSnapshotOf([reading("ANTIGRAVITY", 28), reading("CODEX", 84), reading("CLAUDE", 42)]);
    expect(featured?.provider).toBe("CODEX");
    expect(featuredSnapshotOf([])).toBeNull();
  });

  it("does not feature a non percentage or invalid reading", () => {
    expect(featuredSnapshotOf([{ ...reading("OPENROUTER", 12), unit: "CREDITS" } as Snapshot])).toBeNull();
    expect(featuredSnapshotOf([reading("CODEX", Number.NaN)])).toBeNull();
    expect(featuredSnapshotOf([reading("CODEX", 101)])).toBeNull();
  });
});
