import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFile(path.resolve(process.cwd(), relative), "utf8");

describe("Claude consent documentation", () => {
  it("gives complete shutdown instructions for desktop and command line polling", async () => {
    const [readme, page] = await Promise.all([
      read("packages/cli/README.md"),
      read("apps/web/app/[locale]/docs/cli/page.tsx"),
    ]);
    expect(readme).toContain("Settings, then Show Fable limit, then turn it off");
    expect(readme).toContain("openlimiter config set providers.claude.poll false");
    expect(page).toContain("openlimiter config set providers.claude.poll false");
  });
});
