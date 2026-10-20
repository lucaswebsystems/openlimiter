// @vitest-environment node
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

/**
 * Get started, and the "On this page" list every docs page carries (U80).
 *
 * The page opened with "Node 24 or newer, for the terminal" before the
 * desktop path, which needs nothing installed, and the list of sections only
 * existed from 1280 pixels up. The desktop download now leads, Node is the
 * terminal section's own prerequisite, and below 1280 pixels the same list is
 * a disclosure above the first section.
 */

vi.mock("@/i18n/navigation", async () => {
  const { createElement: element } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => element("a", { href, ...rest }, children),
    redirect: () => undefined,
  };
});
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));

/** The real English catalog, with rich text tags rendered by the caller's functions. */
function translator(namespace: string) {
  const lookup = (key: string): string => {
    let node: unknown = en;
    for (const step of `${namespace}.${key}`.split(".")) node = (node as Record<string, unknown> | undefined)?.[step];
    if (typeof node !== "string") throw new Error(`missing message: ${namespace}.${key}`);
    return node;
  };
  const t = (key: string) => lookup(key);
  t.rich = (key: string, tags: Record<string, (chunks: ReactNode) => ReactNode>) => {
    const parts: ReactNode[] = [];
    let rest = lookup(key);
    for (let match = /<(\w+)>(.*?)<\/\1>/u.exec(rest); match !== null; match = /<(\w+)>(.*?)<\/\1>/u.exec(rest)) {
      parts.push(rest.slice(0, match.index), tags[match[1]]?.(match[2]) ?? match[2]);
      rest = rest.slice(match.index + match[0].length);
    }
    parts.push(rest);
    return createElement(Fragment, null, ...parts);
  };
  return t;
}

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getLocale: async () => "en",
  getTranslations: async (scope: string | { namespace: string }) =>
    translator(typeof scope === "string" ? scope : scope.namespace),
}));

async function getStarted(): Promise<string> {
  const { default: Page } = await import("@/app/[locale]/docs/page");
  /* The page returns the async DocArticle shell; it is awaited here, because
     the static renderer cannot wait for an async component itself. */
  const article = (await Page({ params: Promise.resolve({ locale: "en" }) })) as {
    type: (props: unknown) => Promise<ReactNode>;
    props: unknown;
  };
  return renderToStaticMarkup(await article.type(article.props));
}

const sections = en.docs.pages.index.sections;

describe("Get started", () => {
  it("leads with the desktop download, before anything that needs Node", async () => {
    const html = await getStarted();
    const firstSection = html.slice(html.indexOf("<h2"));
    expect(firstSection).toMatch(/^<h2 id="desktop"/u);
    const desktop = firstSection.slice(0, firstSection.indexOf("<h2", 4));
    expect(desktop).toContain('href="/download"');
    expect(html.indexOf('id="desktop"')).toBeLessThan(html.indexOf("Node 24"));
  });

  it("makes Node the terminal section's own prerequisite", async () => {
    const html = await getStarted();
    const terminal = html.slice(html.indexOf('<h2 id="terminal"'));
    expect(terminal.slice(0, terminal.indexOf("<h2", 4))).toContain(sections.terminal.needs.node);
    expect(html).not.toContain('id="what-you-need"');
  });

  it("shows the section list as a disclosure below 1280 pixels, with every section in it", async () => {
    const html = await getStarted();
    const disclosure = /<details[^>]*class="[^"]*xl:hidden[^"]*"[^>]*>([\s\S]*?)<\/details>/u.exec(html);
    expect(disclosure).not.toBeNull();
    expect(disclosure?.[1]).toContain(en.docs.article.onThisPage);
    for (const id of ["desktop", "terminal", "hub", "free-and-pro", "phone", "claude-code", "from-source", "where-next"]) {
      expect(disclosure?.[1]).toContain(`href="#${id}"`);
    }
    /* The aside keeps the same list from 1280 pixels up. */
    expect(html).toMatch(/<aside class="hidden w-52 flex-none xl:block">/u);
  });
});
