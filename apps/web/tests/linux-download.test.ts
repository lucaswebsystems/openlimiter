// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../messages/de.json";
import en from "../messages/en.json";
import es from "../messages/es.json";
import ja from "../messages/ja.json";
import ptBR from "../messages/pt-BR.json";
import { downloadAssetHref, primaryDownloadHref } from "@/lib/downloads";

/**
 * The Linux download leads with the deb, like the README.
 *
 * The site's Linux button used to download the AppImage, which needs libfuse2
 * and says nothing when it is missing; the README already led with the deb and
 * carried that one line. The card, the button and the steps after it now do the
 * same: the deb first, the rpm and the AppImage beside it, and the libfuse2 line
 * wherever the AppImage is offered.
 */

vi.mock("@/i18n/navigation", () => ({ Link: () => null, redirect: () => undefined }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}));

const catalogs = { en, de, es, ja, "pt-BR": ptBR } as const;

describe("the Linux download", () => {
  it("downloads the deb from the Linux button, with the rpm and the AppImage still offered", () => {
    expect(new URL(primaryDownloadHref("linux")).pathname).toMatch(/\/OpenLimiter-linux-amd64\.deb$/u);
    expect(new URL(downloadAssetHref("linux", "rpm")).pathname).toMatch(/\.rpm$/u);
    expect(new URL(downloadAssetHref("linux", "appImage")).pathname).toMatch(/\.AppImage$/u);
  });

  it("names the deb first on the card and carries the libfuse2 line for the AppImage, in every locale", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const card = catalog.download.choice.linuxSummary;
      expect(card.indexOf("deb"), locale).toBeGreaterThan(-1);
      expect(card.indexOf("deb"), locale).toBeLessThan(card.indexOf("AppImage"));
      expect(card, locale).toContain("libfuse2");
      expect(catalog.download.started.linux.open, locale).not.toContain("AppImage");
      expect(catalog.download.started.linux.packages, locale).toContain("libfuse2");
    }
  });

  it("starts the steps after the button with the deb install command", async () => {
    const { default: Started } = await import("@/app/[locale]/download/started/[platform]/page");
    const html = renderToStaticMarkup(await Started({ params: Promise.resolve({ locale: "en", platform: "linux" }) }));
    expect(html).toContain("sudo apt install ./OpenLimiter-linux-amd64.deb");
    expect(html).not.toContain("chmod +x OpenLimiter-linux-x86_64.AppImage");
  });
});
