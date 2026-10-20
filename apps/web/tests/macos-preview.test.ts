import { describe, expect, it } from "vitest";
import de from "../messages/de.json";
import en from "../messages/en.json";
import es from "../messages/es.json";
import ja from "../messages/ja.json";
import ptBR from "../messages/pt-BR.json";

/**
 * macOS is a preview, said everywhere outside the hero (R39).
 *
 * Since 2.1.6 the macOS app is ad hoc signed but not notarised, opened once
 * through Privacy and Security, and updated by a new download. The site still
 * called it unsigned, listed it as shipped beside Windows and Linux, and
 * promised it would join automatic updates once signed and notarised builds
 * exist. No Mac pass has been run, so there is no Mac promise anywhere.
 */

const catalogs = { en, de, es, ja, "pt-BR": ptBR } as const;
const PREVIEW: Record<keyof typeof catalogs, RegExp> = {
  en: /preview/iu,
  de: /Vorschau/u,
  es: /preliminar/u,
  ja: /プレビュー/u,
  "pt-BR": /prévia/iu,
};

/** Every string the site renders about the macOS build, outside the hero. */
const MAC_STRINGS = [
  "faq.items.desktopOrPhone.answer",
  "download.metaDescription",
  "download.choice.macosSummary",
  "download.started.macos.gatekeeper",
  "download.disclosure.updates",
  "docs.pages.roadmap.sections.not-available.calloutBody",
  "docs.pages.roadmap.sections.desktop.intro",
  "docs.pages.roadmap.sections.desktop.bullets.status",
  "docs.pages.roadmap.sections.desktop.bullets.signing",
  "docs.pages.roadmap.sections.desktop.bullets.updates",
  "home.release.rail.lead",
  "hub.empty.desktop.download.macos",
];

function at(catalog: unknown, path: string): string {
  let node = catalog;
  for (const step of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[step];
  if (typeof node !== "string") throw new Error(`missing ${path}`);
  return node;
}

function leaves(node: unknown, path = "", out: [string, string][] = []): [string, string][] {
  if (typeof node === "string") out.push([path, node]);
  else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) leaves(value, path === "" ? key : `${path}.${key}`, out);
  }
  return out;
}

describe("macOS outside the hero", () => {
  it("is called a preview in every string about the build, in all five locales", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const path of MAC_STRINGS) {
        expect(at(catalog, path), `${locale} ${path}`).toMatch(PREVIEW[locale as keyof typeof catalogs]);
      }
    }
  });

  it("is never called unsigned, and nothing promises signed, notarised or self updating Mac builds", () => {
    for (const [path, text] of leaves(en)) {
      if (path.startsWith("hero.")) continue;
      for (const sentence of text.split(/(?<=[.;:])\s+/u)) {
        if (!/macOS|\bMac\b/u.test(sentence)) continue;
        expect(sentence, path).not.toMatch(/unsigned/iu);
        expect(sentence, path).not.toMatch(/until (?:it can be )?(?:signed|signing|notari)|joins them when|when signed builds exist/iu);
      }
    }
  });

  it("keeps the Gatekeeper steps the build actually needs", () => {
    expect(en.download.started.macos.gatekeeper).toContain("Privacy and Security");
    expect(en.download.started.macos.gatekeeper).toContain("Open Anyway");
    expect(en.download.choice.macosSummary).toContain("Privacy and Security");
  });
});
