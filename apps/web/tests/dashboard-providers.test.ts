// @vitest-environment node
// Reads the dashboard source through import.meta.url, a file URL only under node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import messages from "../messages/en.json";

const dashboard = readFileSync(new URL("../app/app/dashboard.tsx", import.meta.url), "utf8");
const panel = dashboard.slice(dashboard.indexOf('<Panel title={t("providers.title")}'), dashboard.indexOf('<BackToBars', dashboard.indexOf('<Panel title={t("providers.title")}')));

describe("provider desktop prompt", () => {
  it("uses a download link and translated copy for both connection paths", () => {
    expect(dashboard).toContain('import { Link as LocaleLink } from "../../i18n/navigation"');
    expect(panel).toContain('<LocaleLink\n');
    expect(panel).toContain('href="/download"');
    expect(panel).not.toContain("window.location");
    expect(panel).not.toContain("/en/download");
    expect(panel).toContain('selectedProvider.access === "automatic"');
    for (const key of ["title", "automaticPrompt", "manualPrompt", "getDesktop", "close"] as const) {
      expect(panel).toContain(`t("providers.${key}")`);
      expect(messages.hub.providers[key]).not.toMatch(/[-\u2013\u2014]/);
    }
    expect(panel).toContain("setSelectedProvider(null)");
  });
  /* The locale prefix itself is next-intl's job through LocaleLink and is not
     re-tested here: resolving next/navigation needs the Next runtime. */
});
