import type { Metadata, Viewport } from "next";
import { setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { SiteHtml } from "@/components/site-html";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { SITE_NAME, SITE_URL, TITLE_SUFFIX } from "@/lib/site";

/**
 * The blog's own document.
 *
 * WHY THE BLOG IS NOT IN THE LOCALISED TREE
 * -----------------------------------------
 * A post is long form prose with an argument in it. The translation lane is
 * being handed the marketing pages and the documentation, and publishing a post
 * at five URLs with one English body would be worse for a reader and worse for a
 * search engine than publishing it honestly at one. So the blog keeps its path,
 * keeps its language, gets no `hreflang` map, and the middleware leaves `/blog`
 * out of the rewrite.
 *
 * It renders the same document as everything else, through the same component,
 * so the chrome around a post is the chrome around every other page.
 */

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s${TITLE_SUFFIX}` },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

export default function BlogLayout({ children }: Readonly<{ children: ReactNode }>) {
  setRequestLocale(DEFAULT_LOCALE);

  return (
    <SiteHtml locale={DEFAULT_LOCALE} localised={false}>
      {children}
    </SiteHtml>
  );
}
