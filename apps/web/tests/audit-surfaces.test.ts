import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { proseDigest, untranslatedProse } from "../scripts/i18n-prose.mjs";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const locales = ["de", "es", "ja", "pt-BR"];
function flatten(value: Record<string, unknown>, prefix = "", out: Record<string, string> = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") out[path] = child;
    else if (child && typeof child === "object") flatten(child as Record<string, unknown>, path, out);
  }
  return out;
}

describe("published audit surfaces", () => {
  it("17: the pairing page installs an app that launches the account independent paired route", () => {
    const page = read("app/app/pair/page.tsx");
    const manifestPath = page.match(/manifest:\s*"([^"]+)"/u)?.[1];
    expect(manifestPath).toBeTruthy();
    const manifest = JSON.parse(read(`public${manifestPath}`));
    expect(manifest.start_url).toBe("/app/pair");
    expect(manifest.id).toBe("/app/pair");
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
  });

  it("32: rejects new and edited untranslated prose while allowing explicit product terminology", () => {
    const prose = "Open your account to see the latest readings.";
    expect(untranslatedProse("de", "new.body", prose, prose, {})).toBe(true);
    expect(untranslatedProse("de", "new.brand", "Claude Code", "Claude Code", {})).toBe(false);
    const legacy = { "old.body": { digest: proseDigest(prose), locales: ["de"] } };
    expect(untranslatedProse("de", "old.body", prose, prose, legacy)).toBe(false);
    expect(untranslatedProse("es", "old.body", prose, prose, legacy)).toBe(true);
    expect(untranslatedProse("de", "old.body", `${prose} Updated.`, `${prose} Updated.`, legacy)).toBe(true);
  });

  it.each(locales)("32: %s translates new documentation instead of adding it to legacy debt", (locale) => {
    const en = flatten(JSON.parse(read("messages/en.json")));
    const translated = flatten(JSON.parse(read(`messages/${locale}.json`)));
    const legacy = JSON.parse(read("scripts/i18n-legacy-prose.json"));
    for (const [path, prose] of Object.entries(en)) {
      expect(untranslatedProse(locale, path, prose, translated[path], legacy), path).toBe(false);
    }
    for (const path of ["docs.pages.index.sections.terminal.steps", "docs.pages.cli.sections.commands.login.body", "docs.pages.agent-context.sections.terminal.intro"]) {
      expect(translated[path], path).not.toBe(en[path]);
      expect(legacy[path], path).toBeUndefined();
    }
  });

  it.each(["en", ...locales])("33: %s CLI instructions lead to CLI approval", (locale) => {
    const catalog = JSON.parse(read(`messages/${locale}.json`));
    expect(catalog.docs.pages.index.sections.terminal.steps).toContain("openlimiter.com/app/cli");
    expect(catalog.docs.pages.cli.sections.commands.login.body).toContain("openlimiter.com/app/cli");
    expect(read(`messages/${locale}.json`)).not.toContain("openlimiter.com/app/pair");
    expect(read("public/llms.txt")).not.toContain("openlimiter.com/app/pair");
    expect(read("public/llms.txt")).toContain("openlimiter.com/app/cli");
  });
});
