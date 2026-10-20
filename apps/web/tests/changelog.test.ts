// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readChangelog } from "@/lib/changelog";

/**
 * The changelog page (U75).
 *
 * It rendered all of the releases in full, a page some twenty three thousand
 * pixels tall, in a column that hugged the left edge under a centred heading,
 * with releases from 2.0.0 on undated and an English "Notes" heading forced
 * into every locale. The latest three are now open, every older one is one
 * line in a version index that opens in place, every release is dated, and the
 * page adds no word of its own to the quoted file.
 */

/* The shell's own imports reach next-intl's client navigation, which needs a
   Next router; neither decides anything this page is tested on. */
vi.mock("@/i18n/navigation", () => ({ Link: () => null, redirect: () => undefined }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not found"); } }));

vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => Object.assign((key: string) => key, { rich: (key: string) => key }),
}));

async function page(): Promise<string> {
  const { default: ChangelogPage } = await import("@/app/[locale]/changelog/page");
  return renderToStaticMarkup(await ChangelogPage({ params: Promise.resolve({ locale: "en" }) }));
}

/** The markup of one release, from its anchor to the next one. */
function release(html: string, version: string): string {
  const start = html.indexOf(`id="v${version}"`);
  expect(start, version).toBeGreaterThan(-1);
  const next = html.indexOf(' id="v', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

describe("the changelog", () => {
  it("dates every release from 2.0.0 on", async () => {
    const releases = await readChangelog();
    for (const entry of releases.filter((row) => /^2\.(0\.\d|1\.[0-6])$/u.test(row.version))) {
      expect(entry.date, entry.version).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });

  it("adds no heading of its own to notes the file wrote without one", async () => {
    const releases = await readChangelog();
    const ungrouped = releases.find((row) => row.version === "2.1.5")?.entries[0];
    expect(ungrouped?.heading).toBeNull();
    /* The file's own "### Notes" groups in 0.x are quoted; 2.1.5 has none. */
    expect(release(await page(), "2.1.5")).not.toContain("<h3");
  });

  it("opens the latest three and folds every older release into one line that opens in place", async () => {
    const releases = await readChangelog();
    const html = await page();
    for (const latest of releases.slice(0, 3)) {
      expect(release(html, latest.version)).toMatch(/^id="v[^"]+" class="[^"]*mx-auto/u);
    }
    expect(html.match(/<details/gu)?.length).toBe(releases.length - 3);
    const older = releases[3];
    expect(html).toMatch(new RegExp(`<details id="v${older.version.replace(/\./gu, "\\.")}"`, "u"));
    /* The folded line still names the version and its date. */
    expect(release(html, "2.1.0")).toContain("2.1.0</span>");
    expect(release(html, "2.1.0")).toContain("7 October 2026");
  });
});
