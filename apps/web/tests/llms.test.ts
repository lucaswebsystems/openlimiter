// @vitest-environment node
// The generator resolves its files from import.meta.url, which is only a file
// URL under the node environment, not under this suite's default jsdom.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as site from "../lib/site";
// The build entry point is also the pure renderer used by this regression test.
// @ts-expect-error The standalone build script has no declaration file.
import { generateLlms, outputUrl, readSite } from "../scripts/generate-llms.mjs";

describe("generated llms.txt", () => {
  it("matches the committed output byte for byte", () => {
    expect(readFileSync(outputUrl, "utf8")).toBe(generateLlms(site));
  });

  it("reads the same site facts as the application", async () => {
    const loaded = await readSite();
    expect(generateLlms(loaded)).toBe(generateLlms(site));
  });

  it("updates every shared fact when site facts change", () => {
    const changed = {
      ...site,
      CURRENT_VERSION: "9.8.7",
      SITE_NAME: "Example Meter",
      SITE_URL: "https://example.test",
      REPO_URL: "https://example.test/source",
      RELEASES_URL: "https://example.test/releases",
      LICENSE_SPDX_URL: "https://example.test/licence",
      AUTHOR_NAME: "Example Author",
      AUTHOR_SITE: "https://author.example.test",
      PRO_MONTHLY_PRICE: "$7",
      PRO_YEARLY_PRICE: "$70",
    };
    const output = generateLlms(changed);
    expect(output).toContain("Version 9.8.7.");
    expect(output).toContain("Nine ship in 9.8.7.");
    expect(output).toContain("7 US dollars a month or 70 US dollars a year");
    expect(output).toContain("example.test/app/cli");
    for (const key of ["SITE_NAME", "SITE_URL", "REPO_URL", "RELEASES_URL", "LICENSE_SPDX_URL", "AUTHOR_NAME", "AUTHOR_SITE"] as const) {
      expect(output).toContain(changed[key]);
      expect(output).not.toContain(site[key]);
    }
    expect(output).not.toContain(site.CURRENT_VERSION);
  });
});
