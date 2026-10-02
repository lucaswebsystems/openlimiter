// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("uniform provider cards", () => {
  it.each([
    "app/app/dashboard.tsx",
    "app/app/device-view.tsx",
    "app/app/pair/pair-flow.tsx",
  ])("removes the featured hero from %s", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("LiveMeter");
    expect(source).toContain("ProviderRows");
  });
});
