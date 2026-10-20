import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorksWith } from "@/components/works-with";
import de from "../messages/de.json";
import es from "../messages/es.json";
import ja from "../messages/ja.json";
import ptBR from "../messages/pt-BR.json";
import { all, messages as en, render, type Mounted } from "./render";

/**
 * The home page speaks the reader's words, not the test plan's (U71).
 *
 * It marked seven of eight connectors UNVERIFIED in a Parser, Reader, Auth and
 * Verification table, said connectors "fail closed to unknown", and captioned
 * its screenshot "rendered headlessly with synthetic fixtures". Each tool now
 * says whether it works today or may break when the tool updates, from the
 * same reviewed registry, and the verification internals stay in the docs.
 */

vi.mock("@/i18n/navigation", async () => {
  const { createElement: element } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      element("a", { href, ...rest }, children as never),
  };
});

vi.mock("next-intl", async () => {
  const catalog = (await import("../messages/en.json")).default as Record<string, unknown>;
  const lookup = (path: string) => {
    let node: unknown = catalog;
    for (const step of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[step];
    if (typeof node !== "string") throw new Error(`missing message: ${path}`);
    return node;
  };
  return {
    useTranslations: (namespace: string) => {
      const t = (key: string, values?: Record<string, unknown>) =>
        lookup(`${namespace}.${key}`).replace(/\{(\w+)\}/gu, (whole, name: string) =>
          values?.[name] === undefined ? whole : String(values[name]));
      t.rich = (key: string) => lookup(`${namespace}.${key}`).replace(/<\/?\w+>/gu, "");
      return t;
    },
  };
});

const QA = /\bUNVERIFIED\b|VERIFIED_FIXTURES|\bfails? closed\b|\bpars(?:er|ers|ing)\b|headless|\bfixtures?\b/iu;
const HOME = ["about", "deviceFrame", "faq", "home", "integrations", "phonePanels", "pricing", "proFeatures", "worksWith"];

function strings(node: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof node === "string") out.push([path, node]);
  else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) strings(value, `${path}.${key}`, out);
  }
  return out;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("the home page's words", () => {
  it("carries no QA vocabulary in any string it renders", () => {
    for (const namespace of HOME) {
      for (const [path, text] of strings((en as Record<string, unknown>)[namespace], namespace)) {
        expect(text, path).not.toMatch(QA);
      }
    }
    for (const catalog of [de, es, ja, ptBR]) {
      for (const namespace of HOME) {
        for (const [path, text] of strings((catalog as Record<string, unknown>)[namespace], namespace)) {
          expect(text, path).not.toMatch(/UNVERIFIED|VERIFIED_FIXTURES/u);
        }
      }
    }
  });

  it("keeps the verification table off the home page", () => {
    const source = readFileSync(resolve(process.cwd(), "components/works-with.tsx"), "utf8");
    expect(source).not.toContain("ConnectionMatrix");
    expect(en).not.toHaveProperty("connections");
  });

  it("says, per tool, whether it works today or may break when the tool updates", () => {
    mounted = render(createElement(WorksWith));
    const tiles = new Map(
      all(mounted.container, "#providers [title]").map((tile) => [
        tile.getAttribute("title"),
        tile.textContent?.replace(tile.getAttribute("title") ?? "", "").trim(),
      ]),
    );
    const works = en.worksWith.tile.works;
    const mayBreak = en.worksWith.tile.mayBreak;
    expect(Object.fromEntries(tiles)).toEqual({
      "Claude Code": works,
      "OpenAI Codex": works,
      "Google Antigravity": works,
      "Gemini CLI": mayBreak,
      "Grok Build": mayBreak,
      Kimi: mayBreak,
      OpenCode: mayBreak,
      OpenRouter: works,
    });
    expect(mounted.container.querySelector("table")).toBeNull();
  });
});
