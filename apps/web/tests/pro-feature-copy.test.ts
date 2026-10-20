// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../messages/de.json";
import en from "../messages/en.json";
import es from "../messages/es.json";
import ja from "../messages/ja.json";
import ptBR from "../messages/pt-BR.json";
import proFeatures from "@/lib/pro-features.json";

/**
 * Every sentence that lists what Pro adds reads the one list.
 *
 * The announcement, the /pro lead and the two plan sentences each spelled the
 * Pro features out by hand, and none of them named the Ember preset. They now
 * take the list from lib/pro-features.json through `proFeatures.inline`, so
 * Ember is named and a feature added to the list reaches every one of them.
 */

const state = vi.hoisted(() => ({ catalog: {} as Record<string, unknown>, locale: "en" }));

function translatorFor(namespace: string) {
  const t = (key: string, values?: Record<string, unknown>) => {
    let node: unknown = state.catalog;
    for (const step of `${namespace}.${key}`.split(".")) {
      node = node !== null && typeof node === "object" ? (node as Record<string, unknown>)[step] : undefined;
    }
    if (typeof node !== "string") throw new Error(`missing message: ${namespace}.${key}`);
    return node.replace(/\{(\w+)\}/gu, (whole, name: string) => (values?.[name] === undefined ? whole : String(values[name])));
  };
  return Object.assign(t, { rich: t, raw: t });
}

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getLocale: async () => state.locale,
  getTranslations: async (arg: string | { namespace: string }) => translatorFor(typeof arg === "string" ? arg : arg.namespace),
}));
vi.mock("next-intl", () => ({
  hasLocale: (locales: readonly string[], locale: unknown) => locales.includes(String(locale)),
  useLocale: () => state.locale,
  useTranslations: (namespace: string) => translatorFor(namespace),
}));
/* The banner is one link around its sentences, so the link renders its children. */
vi.mock("@/i18n/navigation", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
    redirect: () => undefined,
    usePathname: () => "/pro",
  };
});
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));

const catalogs = { en, de, es, ja, "pt-BR": ptBR } as const;

function inlineLabels(catalog: typeof en): string[] {
  const inline = (catalog.proFeatures as unknown as { inline?: Record<string, string> }).inline ?? {};
  return proFeatures.features.map(({ id }) => inline[id] ?? `<no inline label for ${id}>`);
}

describe("the sentences that list what Pro adds", () => {
  it("name every feature of the one list, Ember included, in the announcement and the /pro lead, in every locale", async () => {
    const { AnnouncementBar } = await import("@/components/announcement-bar");
    const { default: ProPage } = await import("@/app/[locale]/pro/page");
    for (const [locale, catalog] of Object.entries(catalogs)) {
      state.catalog = catalog;
      state.locale = locale;
      const banner = renderToStaticMarkup(await AnnouncementBar());
      const page = renderToStaticMarkup(await ProPage({ params: Promise.resolve({ locale }) }));
      for (const label of inlineLabels(catalog)) {
        expect(banner, `${locale} banner`).toContain(label);
        expect(page, `${locale} /pro lead`).toContain(label);
      }
      expect(banner, locale).toContain("Ember");
    }
  });

  it("read the list into both plan sentences in every locale", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(catalog.proPortal.plan.active.body, locale).toContain("{features}");
      expect(catalog.proPortal.plan.trial.body, locale).toContain("{features}");
    }
  });

  it("joins English the Commonwealth way, without a serial comma", async () => {
    const { proFeaturePhrase } = await import("@/lib/pro-feature-list");
    const phrase = proFeaturePhrase((id) => `[${id}]`, "en");
    expect(phrase).toBe(proFeatures.features.map(({ id }) => `[${id}]`).join(", ").replace(/, (\[[^\]]+\])$/u, " and $1"));
  });
});
