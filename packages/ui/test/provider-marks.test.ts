/**
 * The artwork on disk and the artwork that ships are the same drawing.
 *
 * provider-row.ts inlines each mark so the shared row renders inside a shadow
 * root without a network request. That is a copy, and a copy drifts. This
 * suite compares the geometry of every file in src/marks against the geometry
 * the row inlines, so editing one and forgetting the other fails here instead
 * of shipping two versions of a provider's identity.
 *
 * The 2.1 providers' files are different in kind: each is the vendor's own
 * file, kept byte for byte, so they are held to their recorded digest and
 * source instead of to our drawing rules.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { providerRowMarkup } from "../src/provider-row.js";
import type { ProviderAccountRowView } from "../src/provider-row.js";
import { PENDING_PROVIDER_CODES, type ProviderCode } from "@openlimiter/core";

const MARKS_DIRECTORY = path.join(process.cwd(), "packages", "ui", "src", "marks");

/** The 2.1 providers, whose marks are the vendors' own files. */
type OfficialCode = "SYNTHETIC" | "ZAI" | "MINIMAX" | "CLINE" | "AUGMENT" | "AMP" | "KILO" | "COPILOT";

// Cursor uses a text fallback until the UI owner supplies its mark.
const FILE_BY_PROVIDER: Readonly<Record<Exclude<ProviderCode, "CURSOR" | OfficialCode>, string>> = {
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

/** File, registry spec and the digest of the file as the vendor published it. */
const OFFICIAL_BY_PROVIDER: Readonly<Record<OfficialCode, { file: string; spec: string; sha256: string }>> = {
  SYNTHETIC: { file: "synthetic.svg", spec: "synthetic/subscription", sha256: "271da15c7a7596e5a491481ce6b3f3290749e302f87b03d1f0a91cceede7f8e9" },
  ZAI: { file: "zai.svg", spec: "zai/coding-plan", sha256: "07a45e8e35b0b631ed2c68cd1cb041f9721b1ceeb0bd0e34f1459b0304a741c7" },
  MINIMAX: { file: "minimax.svg", spec: "minimax/token-plan", sha256: "90c43806b801dd6db9bf95613f9a5634cc83a1c7f303ea192eec37d985baa631" },
  CLINE: { file: "cline.svg", spec: "cline/hosted", sha256: "267e6a8fdc37e3ad3ebedf843584ad1b6b0fe62cde28cfa4c5702006184970bb" },
  AUGMENT: { file: "augment.svg", spec: "augment/auggie", sha256: "f0b6b8f09e2fa7293214c6a3076dfcfe8a265a9c1ad56455cb36831db6027da7" },
  AMP: { file: "amp.svg", spec: "amp/cli", sha256: "40c79d8c7baa04c2fee214cc1c66a9797eb6aa96bec6c5b20c7d12cd66490696" },
  KILO: { file: "kilo.svg", spec: "kilo/cli", sha256: "0e8115fe04e4bb07a2122cb66ddc718a7cdfb18fdcfa020bf5dfb51fd92d75e9" },
  COPILOT: { file: "copilot.svg", spec: "github/copilot", sha256: "d5aa364673444e6158fedb206efa2aa71886b465921d8911de3cb4e7a3a951bc" },
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

/** No raster, no remote reference, no font: the checks every mark passes. */
function expectSelfContained(asset: string, file: string, namespaces: readonly string[]): void {
  expect(asset, file).not.toContain("<image");
  expect(asset, file).not.toMatch(/<script/iu);
  expect(asset, file).not.toMatch(/(?:xlink:)?href\s*=\s*"[a-z]+:/u);
  expect(asset, file).not.toMatch(/url\(\s*['"]?[a-z]+:/u);
  expect(asset, file).not.toContain("@font-face");
  expect(asset, file).not.toContain("@import");
  let stripped = asset;
  for (const namespace of namespaces) stripped = stripped.replaceAll(namespace, "");
  expect(stripped, file).not.toMatch(/https?:\/\//u);
}

describe("provider marks", () => {
  it("keeps one file per provider and no orphans", () => {
    const onDisk = readdirSync(MARKS_DIRECTORY)
      .filter((name) => name.endsWith(".svg"))
      .sort();
    expect(onDisk).toEqual([
      ...Object.values(FILE_BY_PROVIDER),
      ...Object.values(OFFICIAL_BY_PROVIDER).map((entry) => entry.file),
    ].sort());
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
    /* The one permitted absolute URL in our drawings is the SVG namespace,
       which is a name rather than an address and is never fetched. A vendor
       file may also declare the XLink namespace, which is the same kind of
       name. */
    for (const file of Object.values(FILE_BY_PROVIDER)) {
      const asset = readFileSync(path.join(MARKS_DIRECTORY, file), "utf8");
      expectSelfContained(asset, file, ['xmlns="http://www.w3.org/2000/svg"']);
    }
    for (const { file } of Object.values(OFFICIAL_BY_PROVIDER)) {
      const asset = readFileSync(path.join(MARKS_DIRECTORY, file), "utf8");
      expectSelfContained(asset, file, ["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xlink"]);
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

  it("keeps every vendor file byte for byte as it was published", () => {
    for (const [provider, { file, sha256 }] of Object.entries(OFFICIAL_BY_PROVIDER)) {
      const bytes = readFileSync(path.join(MARKS_DIRECTORY, file));
      expect(createHash("sha256").update(bytes).digest("hex"), provider).toBe(sha256);
    }
  });

  it("draws no vendor file on the row of a provider that is still switched off", () => {
    for (const [provider, { file }] of Object.entries(OFFICIAL_BY_PROVIDER)) {
      if (!(PENDING_PROVIDER_CODES as readonly string[]).includes(provider)) continue;
      const asset = readFileSync(path.join(MARKS_DIRECTORY, file), "utf8");
      const markup = providerRowMarkup(rowFor(provider as ProviderCode));
      expect(markup, provider).not.toContain(geometry(asset));
      expect(markup, provider).not.toContain("<svg");
    }
  });

  it("records every source and the trademark note", () => {
    const licenses = readFileSync(path.join(MARKS_DIRECTORY, "LICENSES.md"), "utf8");
    for (const file of Object.values(FILE_BY_PROVIDER)) {
      expect(licenses, file).toContain("`" + file + "`");
    }
    for (const { file, sha256 } of Object.values(OFFICIAL_BY_PROVIDER)) {
      expect(licenses, file).toContain("`" + file + "`");
      expect(licenses, file).toContain("`" + sha256 + "`");
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

  it("records each vendor file's source in the provider's registry spec", async () => {
    const { parseYamlSubset } = await import(
      pathToFileURL(path.resolve("scripts/validate-provider-specs.mjs")).href
    );
    const licenses = readFileSync(path.join(MARKS_DIRECTORY, "LICENSES.md"), "utf8");
    for (const [provider, { file, spec }] of Object.entries(OFFICIAL_BY_PROVIDER)) {
      const where = path.join("provider_specs", spec + ".yaml");
      const document = parseYamlSubset(readFileSync(where, "utf8"), where);
      expect(document.mark?.file, provider).toBe(file);
      expect(document.mark?.source_url, provider).toMatch(/^https:\/\//u);
      /* One source, stated the same way in both places. */
      expect(licenses, provider).toContain("| " + document.mark.source_url + " |");
    }
  });
});
