// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error The standalone build script has no declaration file.
import { localPath, pullChangelog, rootPath } from "../scripts/pull-changelog.mjs";

describe("the tracked changelog copy", () => {
  it("matches the repository root CHANGELOG.md after a pull", () => {
    pullChangelog();
    expect(readFileSync(localPath, "utf8")).toBe(readFileSync(rootPath, "utf8"));
  });

  it("keeps the root as the single authored source path", () => {
    expect(rootPath.endsWith("CHANGELOG.md")).toBe(true);
    expect(localPath.endsWith("CHANGELOG.md")).toBe(true);
    expect(rootPath).not.toBe(localPath);
  });
});