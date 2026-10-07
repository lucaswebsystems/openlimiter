// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { downloadAssetHref, primaryDownloadHref } from "../lib/downloads";
import { CURRENT_VERSION } from "../lib/site";

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => en.meta[key as keyof typeof en.meta],
}));

describe("2.0 site release", () => {
  it("uses the six aliases published by L8.2, with no version in their names", () => {
    expect(CURRENT_VERSION).toBe("2.1.1");
    const links = [primaryDownloadHref("windows"), downloadAssetHref("windows", "msi"),
      primaryDownloadHref("macos"), primaryDownloadHref("linux"),
      downloadAssetHref("linux", "deb"), downloadAssetHref("linux", "rpm")];
    expect(links.map(href => new URL(href).pathname)).toEqual([
      "/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-windows-x64-setup.exe",
      "/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-windows-x64.msi",
      "/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-macos-universal.dmg",
      "/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-linux-x86_64.AppImage",
      "/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-linux-amd64.deb",
      "/lucaswebsystems/openlimiter/releases/latest/download/OpenLimiter-linux-x86_64.rpm",
    ]);
  });

  it("publishes the release version and the free, monthly and annual offers", async () => {
    const { softwareApplicationSchema, jsonLdText } = await import("../lib/jsonld");
    const schema = JSON.parse(jsonLdText(await softwareApplicationSchema("en")));
    expect(schema.softwareVersion).toBe("2.1.1");
    expect(schema.dateModified).toBe("2026-10-07");
    expect(schema.offers.map((offer: { price: string }) => offer.price)).toEqual(["0", "5", "50"]);
  });

  it("keeps the hero call and puts release sections after it", () => {
    const page = readFileSync(new URL("../app/[locale]/page.tsx", import.meta.url), "utf8");
    expect(page.match(/<Hero\s*\/>/g)).toHaveLength(1);
    expect(page.indexOf("<ReleaseOverview />")).toBeGreaterThan(page.indexOf("<Hero />"));
  });

  it("distinguishes free local alerts from remote Pro alerts without prose dashes", () => {
    expect(en.pricing.pro.cta).toBe("Start your free 30 day Pro trial");
    expect(en.pricing.pro.lines.alerts).toContain("Local desktop alerts are free");
    expect(en.announce.message).toContain("Desktop alerts");
    expect(en.announce.message).not.toContain("$100");
    expect(en.pricing.pro.lead).toContain("history");
    expect(en.pricing.pro.lines.heavyApi).not.toContain("$100");
    expect(en.faq.items.phoneAccess.answer).toContain("does not require Pro");
    expect(en.docs.pages.providers.description).toContain("eight");
    expect(en.docs.pages.security.sections.reporting.address).toContain("lucas@lucaswebsystems.com");
    for (const value of JSON.stringify(en.home.release).matchAll(/:"([^"]+)"/g)) {
      expect(value[1]).not.toMatch(/[-\u2010-\u2015]/u);
    }
  });
});
