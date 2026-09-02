/**
 * The artwork on disk and the artwork that ships are the same drawing.
 *
 * provider-row.ts inlines each mark so the shared row renders inside a shadow
 * root without a network request. That is a copy, and a copy drifts. This
 * suite compares the geometry of every file in src/marks against the geometry
 * the row inlines, so editing one and forgetting the other fails here instead
 * of shipping two versions of a provider's identity.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { providerRowMarkup } from "../src/provider-row.js";
import type { ProviderAccountRowView } from "../src/provider-row.js";
import type { ProviderCode } from "@openlimiter/core";

const MARKS_DIRECTORY = path.join(process.cwd(), "packages", "ui", "src", "marks");

const FILE_BY_PROVIDER: Readonly<Record<ProviderCode, string>> = {
  CLAUDE: "claude.svg",
  OPENROUTER: "openrouter.svg",
  CODEX: "codex.svg",
  ANTIGRAVITY: "antigravity.svg",
  GEMINI_CLI: "gemini.svg",
  OPENCODE: "opencode.svg",
  GROK: "grok.svg",
  KIMI: "kimi.svg",
  MANUAL: "manual.svg",
};

/** Everything inside the root element: the drawing, without its frame. */
function geometry(svg: string): string {
  const opening = svg.indexOf(">");
  const closing = svg.lastIndexOf("</svg>");
  expect(opening).toBeGreaterThan(0);
  expect(closing).toBeGreaterThan(opening);
  return svg.slice(opening + 1, closing).replaceAll(/\s+/gu, " ").trim();
}

function rowFor(provider: ProviderCode): ProviderAccountRowView {
  return {
    key: provider + "::",
    provider,
    providerLabel: provider,
    accountId: null,
    accountLabel: "Account",
    showAccountLabel: false,
    sourceLabel: null,
    windows: [],
    fallback: null,
    failure: null,
    demo: false,
  };
}

describe("provider marks", () => {
  it("keeps one file per provider and no orphans", () => {
    const onDisk = readdirSync(MARKS_DIRECTORY)
      .filter((name) => name.endsWith(".svg"))
      .sort();
    expect(onDisk).toEqual(Object.values(FILE_BY_PROVIDER).sort());
  });

  it("ships the drawing that is on disk", () => {
    for (const [provider, file] of Object.entries(FILE_BY_PROVIDER)) {
      const asset = readFileSync(path.join(MARKS_DIRECTORY, file), "utf8");
      const markup = providerRowMarkup(rowFor(provider as ProviderCode));
      expect(markup, provider).toContain(geometry(asset));
    }
  });

  it("sizes every mark with CSS rather than with attributes", () => {
    for (const file of Object.values(FILE_BY_PROVIDER)) {
      const asset = readFileSync(path.join(MARKS_DIRECTORY, file), "utf8");
      expect(asset, file).toContain('viewBox="0 0 24 24"');
      expect(asset, file).not.toMatch(/<svg[^>]*\swidth=/u);
      expect(asset, file).not.toMatch(/<svg[^>]*\sheight=/u);
    }
  });

  it("keeps the artwork self contained", () => {
    for (const file of Object.values(FILE_BY_PROVIDER)) {
      const asset = readFileSync(path.join(MARKS_DIRECTORY, file), "utf8");
      /* No raster, no remote reference, no font. Geometry only. The one
         permitted absolute URL is the SVG namespace, which is a name rather
         than an address and is never fetched. */
      expect(asset, file).not.toContain("<image");
      expect(asset, file).not.toMatch(/(?:xlink:)?href\s*=\s*"[a-z]+:/u);
      expect(asset, file).not.toMatch(/url\(\s*['"]?[a-z]+:/u);
      expect(asset, file).not.toContain("@font-face");
      expect(
        asset.replaceAll('xmlns="http://www.w3.org/2000/svg"', ""),
        file
      ).not.toMatch(/https?:\/\//u);
    }
  });

  it("gives every brand variable an official fallback", () => {
    for (const file of Object.values(FILE_BY_PROVIDER)) {
      const asset = readFileSync(path.join(MARKS_DIRECTORY, file), "utf8");
      for (const reference of asset.matchAll(/var\((--[a-z0-9-]+)([^)]*)\)/gu)) {
        expect(reference[2], file + " " + String(reference[1])).toMatch(
          /^,\s*#[0-9a-f]{6}$/u
        );
      }
    }
  });

  it("records every source and the trademark note", () => {
    const licenses = readFileSync(path.join(MARKS_DIRECTORY, "LICENSES.md"), "utf8");
    for (const file of Object.values(FILE_BY_PROVIDER)) {
      expect(licenses, file).toContain("`" + file + "`");
    }
    /* The note is one sentence to a reader and several lines to a text editor,
       so the wrapping and the blockquote markers come out before comparing. */
    const prose = licenses.replaceAll(/^>\s?/gmu, "").replaceAll(/\s+/gu, " ");
    expect(prose).toContain(
      "Product names, logos, brands, and other trademarks featured or referred to " +
        "within OpenLimiter are the property of their respective trademark holders."
    );
    expect(prose).toContain(
      "These trademark holders are not affiliated with OpenLimiter, our products, " +
        "or our website. They do not sponsor or endorse OpenLimiter. Use of them " +
        "does not imply any affiliation with or endorsement by them."
    );
  });
});
