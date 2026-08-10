import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE, LOCALES, LOCALE_FACES, type Locale } from "@/i18n/locales";
import { localePath } from "@/i18n/routing";
import { findDocPage } from "./docs";
import { AUTHOR_NAME, SITE_NAME, TITLE_SUFFIX } from "./site";

/**
 * Per page metadata, built once.
 *
 * Next inherits the root `openGraph` block wholesale when a page does not set
 * one, which is how every subpage on this site ended up sharing the home page's
 * social title and description. A page that goes through this helper cannot do
 * that: its card always carries its own title, its own description and its own
 * URL.
 *
 * The social title is the page title plus the suffix the title template
 * appends, so the card and the tag in the head say exactly the same words. The
 * suffix is read from lib/site.ts rather than typed here, because a template
 * that changes in one of those two places and not the other is the whole
 * failure this helper exists to avoid.
 *
 * WHAT INTERNATIONALISATION ADDED
 * -------------------------------
 * A page now takes a route and a locale rather than a finished path, and it gets
 * its canonical and its five alternates from the same function the sitemap and
 * the switcher use. Three surfaces have to agree about where a page lives in
 * five languages, and they agree by all asking `localePath`.
 */

/**
 * The canonical, plus every language this route exists in.
 *
 * `x-default` points at English. It is not a sixth language: it is what a search
 * engine serves a reader whose language matches none of the five, and pointing
 * it at the default is what stops that reader being sent somewhere arbitrary.
 *
 * Every alternate is absolute, because a `hreflang` map of relative paths is the
 * one thing Google's report calls invalid rather than merely suboptimal, and
 * Next only makes `alternates.canonical` absolute for you.
 */
export function localeAlternates(route: string, locale: Locale): Metadata["alternates"] {
  const languages: Record<string, string> = {};
  for (const other of LOCALES) languages[other] = localePath(other, route);
  languages["x-default"] = localePath(DEFAULT_LOCALE, route);

  return { canonical: localePath(locale, route), languages };
}

export interface PageMetadataInput {
  /** The page's own title, before the template appends the site name. */
  title: string;
  description: string;
  /**
   * The route, always the unprefixed English pathname. The locale is applied
   * here rather than by the caller, so no page can hand in a path with a locale
   * already on it and end up with `/pt-BR/pt-BR/download`.
   */
  route: string;
  locale: Locale;
  /**
   * Set when the title tag bypasses the template, which a blog post does
   * because its own title already opens with the product name.
   */
  absoluteTitle?: boolean;
  /** Present on a post, which makes the card an article rather than a page. */
  published?: string;
  /**
   * Off for a route that exists in English only, which is the blog, the founder
   * console and the web application. They get a canonical and no `hreflang` map,
   * because advertising a translation that does not exist is worse for a search
   * engine than advertising nothing.
   */
  localised?: boolean;
}

export function pageMetadata(input: PageMetadataInput): Metadata {
  const {
    title,
    description,
    route,
    locale,
    absoluteTitle = false,
    published,
    localised = true,
  } = input;

  const social = absoluteTitle ? title : `${title}${TITLE_SUFFIX}`;
  const path = localePath(locale, route);

  const shared = {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: localised ? localeAlternates(route, locale) : { canonical: path },
    twitter: {
      card: "summary_large_image" as const,
      title: social,
      description,
    },
  };

  const ogLocale = LOCALE_FACES[locale].ogLocale;

  if (published !== undefined) {
    return {
      ...shared,
      openGraph: {
        type: "article",
        url: path,
        siteName: SITE_NAME,
        title: social,
        description,
        locale: ogLocale,
        publishedTime: published,
        authors: [AUTHOR_NAME],
      },
    };
  }

  return {
    ...shared,
    openGraph: {
      type: "website",
      url: path,
      siteName: SITE_NAME,
      title: social,
      description,
      locale: ogLocale,
    },
  };
}

/**
 * A documentation page's metadata, from the same list that draws the sidebar.
 *
 * A doc page may carry a longer meta title than the label in the sidebar, so a
 * search result can describe the page while the navigation stays short. When it
 * has none, the sidebar label is the title, which is what every page did before
 * this existed.
 *
 * Both strings now come from the catalog, keyed by the page's identifier, so a
 * translated documentation page has a translated title tag rather than an
 * English one over Portuguese prose.
 */
export async function docMetadata(href: string, locale: Locale): Promise<Metadata> {
  const page = findDocPage(href);

  if (page === undefined) {
    return { alternates: localeAlternates(href, locale) };
  }

  const t = await getTranslations({ locale, namespace: `docs.pages.${page.id}` });
  const metaTitle = t.has("metaTitle") ? t("metaTitle") : t("title");

  return pageMetadata({
    title: metaTitle,
    description: t("description"),
    route: href,
    locale,
  });
}
