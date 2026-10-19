import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFile(path.resolve(process.cwd(), relative), "utf8");

describe("Claude consent documentation", () => {
  it("gives complete shutdown instructions for desktop and command line polling", async () => {
    const [readme, page, labels, app] = await Promise.all([
      read("packages/cli/README.md"),
      read("apps/web/app/[locale]/docs/cli/page.tsx"),
      read("apps/desktop/ui/readings.en.json"),
      read("apps/desktop/ui/app.js"),
    ]);
    /* The desktop switch lives in the Claude row's menu on Connect Tools,
       never in Settings, under the names the window shows. */
    const { connectToolsTab, showClaudeFable } = JSON.parse(labels) as Record<string, string>;
    expect(readme).toContain(`open ${connectToolsTab}, then the menu at the end of the Claude row, then turn ${showClaudeFable} off`);
    expect(readme).not.toContain("open Settings");
    expect(app).toMatch(/function fillMore\(tool, panel\) \{[\s\S]*tool\.code === "CLAUDE"[\s\S]*say\("showClaudeFable"\)/u);
    expect(readme).toContain("openlimiter config set providers.claude.poll false");
    expect(page).toContain("openlimiter config set providers.claude.poll false");
  });
});
