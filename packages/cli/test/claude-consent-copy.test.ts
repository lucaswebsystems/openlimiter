import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFile(path.resolve(process.cwd(), relative), "utf8");

describe("Claude consent documentation", () => {
  it("says the request is off until turned on, and how to turn it on and off on desktop and command line", async () => {
    const [readme, page, labels, app] = await Promise.all([
      read("packages/cli/README.md"),
      read("apps/web/app/[locale]/docs/cli/page.tsx"),
      read("apps/desktop/ui/readings.en.json"),
      read("apps/desktop/ui/app.js"),
    ]);
    /* The desktop switch lives in the Claude row's menu on Connect Tools,
       never in Settings, under the names the window shows. */
    const { connectToolsTab, showClaudeFable } = JSON.parse(labels) as Record<string, string>;
    expect(readme).toContain("The direct Claude request is off until you turn it on, and nothing asks you to.");
    expect(readme).toContain(`open ${connectToolsTab}, then the menu at the end of the Claude row, then turn ${showClaudeFable} on; turn the same switch off to stop it`);
    expect(readme).toContain("openlimiter config set providers.claude.poll true");
    expect(readme).not.toContain("open Settings");
    expect(readme).not.toMatch(/asks once|records off/u);
    expect(app).toMatch(/function fillMore\(tool, panel\) \{[\s\S]*tool\.code === "CLAUDE"[\s\S]*say\("showClaudeFable"\)/u);
    expect(readme).toContain("openlimiter config set providers.claude.poll false");
    expect(page).toContain("openlimiter config set providers.claude.poll false");
  });

  /* 2.1.7, plan items 7 and 8: the request is opt in. Its switch names the
     request itself, and the note says what it sends, to whom, how often, that
     it becomes the source of every Claude bar, and that Anthropic's policy for
     tools like this is unresolved. */
  it("names the request on its switch and says what it sends, to whom and how often", async () => {
    const [labels, web] = await Promise.all([
      read("apps/desktop/ui/readings.en.json"),
      read("apps/web/messages/en.json"),
    ]);
    const desktop = JSON.parse(labels) as Record<string, string>;
    expect(desktop["showClaudeFable"]).toBe("Read my Claude usage from Anthropic");
    const note = desktop["showClaudeFableNote"] ?? "";
    for (const fact of [
      "Off unless you turn it on",
      "your Claude Code login",
      "only to Anthropic",
      "about every five minutes",
      "every Claude bar",
      "Anthropic's policy for tools like this is unresolved"
    ]) expect(note).toContain(fact);
    expect(note).not.toMatch(/Fable|[–—]| - /u);
    const twins = (JSON.parse(web) as { desktopReadings: Record<string, string> }).desktopReadings;
    expect(twins["showClaudeFable"]).toBe(desktop["showClaudeFable"]);
    expect(twins["showClaudeFableNote"]).toBe(note);
  });
});
