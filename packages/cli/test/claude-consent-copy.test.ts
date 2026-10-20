import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";

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
    /* Strings the window no longer draws anywhere leave with their twins. */
    for (const retired of ["useClaudeSignIn", "useClaudeSignInTitle"]) {
      expect(desktop[retired], retired).toBeUndefined();
      expect(twins[retired], retired).toBeUndefined();
    }
  });

  /* Astra fix round, finding 7, the same claim in its other homes: the
     command line help, the documentation page that prints it, and the
     documentation's refresh entry in every locale never state a fifteen
     minute ceiling that the Claude usage request, about every five minutes,
     exceeds. */
  it("names the Claude usage request wherever refresh states its fifteen minute cadence", async () => {
    const flat = (text: string) => text.replace(/\s+/gu, " ");
    const help = flat((await runCli(["help"])).stdout);
    const page = flat(await read("apps/web/app/[locale]/docs/cli/page.tsx"));
    for (const [name, text] of [["help", help], ["docs page", page]] as const) {
      expect(text, name).toContain("at most once every 15 minutes, or about every 5 minutes for the Claude usage request once it is on.");
    }
    const english = JSON.parse(await read("apps/web/messages/en.json")) as {
      docs: { pages: { cli: { sections: { commands: { refresh: { body: string } } } } } };
    };
    expect(english.docs.pages.cli.sections.commands.refresh.body)
      .toContain("The direct Claude usage request, once you turn it on, reads about every five minutes instead.");
    for (const locale of ["de", "es", "ja", "pt-BR"]) {
      const catalog = JSON.parse(await read("apps/web/messages/" + locale + ".json")) as typeof english;
      expect(catalog.docs.pages.cli.sections.commands.refresh.body, locale).toMatch(/Claude.*(5|fünf|cinco)/u);
    }
  });

  it("tells the same opt in story in the security policy and the zero setup notes", async () => {
    const [security, zeroSetup] = await Promise.all([read("SECURITY.md"), read("docs/ZERO_SETUP_DETECTION.md")]);
    for (const [name, text] of [["SECURITY.md", security], ["ZERO_SETUP_DETECTION.md", zeroSetup]] as const) {
      const flat = text.replace(/\s+/gu, " ");
      expect(flat, name).toContain("off until you turn it on");
      expect(flat, name).toContain("Read my Claude usage from Anthropic");
      expect(flat, name).toContain("about every five minutes");
      expect(flat, name).not.toMatch(/Show Fable limit|asks once|records off|after a disclosure|new desktop installs/iu);
    }
    /* Astra fix round, finding 7: a failed request never hands the bars to a
       payload, and no fifteen minute ceiling is stated that the request exceeds. */
    expect(zeroSetup.replace(/\s+/gu, " ")).not.toMatch(/after OAuth expiry|accepted again|if both sources fail/iu);
    const readme = (await read("packages/cli/README.md")).replace(/\s+/gu, " ");
    const cadence = readme.split(/(?<=\.) /u).filter((sentence) => sentence.includes("fifteen minutes"));
    expect(cadence.length).toBeGreaterThan(0);
    for (const sentence of cadence) expect(sentence).toMatch(/except the direct Claude usage request/u);
  });
});
