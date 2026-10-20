// @vitest-environment node
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

/**
 * The three desktop tabs on the home page (U83).
 *
 * They were drawn three across at about 350 pixels each, so their text was
 * some four pixels tall and read as texture. The Usage tab is now drawn alone
 * at its real size, and the other two are named under it in words.
 */

function lookup(path: string): string {
  let node: unknown = en;
  for (const step of path.split(".")) node = (node as Record<string, unknown> | undefined)?.[step];
  if (typeof node !== "string") throw new Error(`missing message: ${path}`);
  return node;
}

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => lookup(`${namespace}.${key}`),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => lookup(`${namespace}.${key}`),
}));
vi.mock("@/i18n/navigation", async () => {
  const { createElement } = await import("react");
  return { Link: ({ href, children }: { href: string; children?: ReactNode }) => createElement("a", { href }, children) };
});
vi.mock("next/navigation", () => ({ notFound: () => undefined }));
/* The terminal and phone panels have their own tests and nothing to do here. */
vi.mock("@/components/terminal-statusline", () => ({ TerminalStatusline: () => null }));
vi.mock("@/components/phone-panels", () => ({ PhonePanels: () => null }));

describe("the desktop tabs on the home page", () => {
  it("draws the Usage tab alone at its real size and names the other two tabs in words", async () => {
    const { ReleaseOverview } = await import("@/components/release-overview");
    const html = renderToStaticMarkup(await ReleaseOverview());
    const agents = html.slice(html.indexOf('id="agents"'), html.indexOf('id="terminal"'));
    expect(agents.match(/<picture/gu)).toHaveLength(1);
    expect(agents).toContain("/screenshots/desktop-home");
    expect(agents).not.toContain("desktop-connect");
    expect(agents).not.toContain("desktop-settings");
    /* Real size: the figure keeps the capture's own 1000 pixel cap, not a third of a row. */
    expect(agents).toContain("max-width:1000px");
    expect(agents).not.toContain("md:grid-cols-3");
    expect(agents).toContain(en.home.release.agents.desktopConnectNote);
    expect(agents).toContain(en.home.release.agents.desktopSettingsNote);
  });
});
