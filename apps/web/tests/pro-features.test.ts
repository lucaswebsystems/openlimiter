import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import list from "@/lib/pro-features.json";
import de from "../messages/de.json";
import en from "../messages/en.json";
import es from "../messages/es.json";
import ja from "../messages/ja.json";
import ptBR from "../messages/pt-BR.json";

/**
 * The one Pro feature list (U57, U63, U72).
 *
 * Pro is sold on the site, offered on the hub and the phone, and described in
 * llms.txt, and each of those used to carry its own list: four lines on the
 * pricing card, four on the hub with the cloud meter filed under "phone", a
 * phone pairing bullet in the docs that is free, and six on the desktop. One
 * JSON file now holds the list and every surface reads it; these tests pin the
 * decided contents and fail the moment a surface keeps a list of its own.
 */

const catalogs = { de, en, es, ja, "pt-BR": ptBR } as const;
/* Read from the app root: jsdom's own URL class is not one node's fs accepts. */
const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("the one Pro feature list", () => {
  it("is the five things Pro adds, in the decided order, with the entitlement each one is", () => {
    expect(list.features.map((feature) => [feature.id, feature.entitlement])).toEqual([
      ["multiAccount", "multi_account"],
      ["history", "history"],
      ["alerts", "alerts"],
      ["apiSpend", "api_spend_beta"],
      ["ember", "theme_preset"],
    ]);
  });

  it("has a sentence for every entry in all five catalogs, and English is the list's own", () => {
    const ids = list.features.map((feature) => feature.id);
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(Object.keys((catalog as { proFeatures: object }).proFeatures), locale).toEqual(ids);
    }
    for (const feature of list.features) {
      expect(en.proFeatures[feature.id as keyof typeof en.proFeatures]).toBe(feature.label);
    }
    /* Desktop alerts are free, and the list says so where it names alerts. */
    expect(en.proFeatures.alerts).toContain("Desktop alerts");
  });

  it("is read by the site, the hub, the phone, the docs and llms.txt rather than written into them", () => {
    for (const file of [
      "components/pricing.tsx",
      "app/app/trial.tsx",
      "app/[locale]/docs/roadmap/page.tsx",
      "scripts/generate-llms.mjs",
    ]) {
      expect(source(file), file).toContain("pro-features.json");
    }
    /* The phone's Pro tab draws the hub's card, so it reads the same list. */
    expect(source("app/app/pair/pro-tab.tsx")).toContain("ProLockCard");
    expect(source("components/pricing.tsx")).not.toContain("PRO_LINES");
    expect(source("app/app/trial.tsx")).not.toContain("PRO_SURFACES");
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(catalog.pricing.pro, locale).not.toHaveProperty("lines");
      expect(catalog.hub.pro, locale).not.toHaveProperty("feature");
      expect(catalog.docs.pages.roadmap.sections.sync.bullets, locale).not.toHaveProperty("phone");
    }
  });

  it("never counts the list in prose, so a sixth line cannot make a sentence false", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(catalog.pricing.pro.lead, locale).not.toMatch(/\b(four|five|vier|fünf|cuatro|cinco|quatro)\b|4つ|5つ/iu);
      expect(catalog.faq.items.pro.answer, locale).not.toMatch(/\b(four|five|vier|fünf|cuatro|cinco|quatro)\b|4つ|5つ/iu);
    }
  });
});
