import type { MetadataRoute } from "next";
import { LOCALES, type Locale } from "@/i18n/locales";
import { localePath } from "@/i18n/routing";
import { posts } from "@/lib/blog";
import { docPages } from "@/lib/docs";
import { SITE_URL } from "@/lib/site";

/**
 * Every public route, generated from the same lists the pages render, so a page
 * cannot exist in the navigation and be missing from the sitemap.
 *
 * IT IS TWO LISTS NOW, NOT ONE
 * ----------------------------
 * A localised route appears once per language, five rows, each carrying the
 * other four as `alternates.languages` plus `x-default`. That is the pairing a
 * search engine reads to understand that these are the same page rather than
 * five thin duplicates, and it is built from `localePath`, which is the same
 * function the canonical tags and the footer switcher use.
 *
 * An English only route appears once, with no alternates at all. The blog and
 * web application are English by decision, and claiming a translation that
 * does not exist is worse than claiming nothing.
 */

/** The localised routes, in the order a reader meets them. */
const LOCALISED_ROUTES: readonly { route: string; priority: number }[] = [
  { route: "/", priority: 1 },
  { route: "/pricing", priority: 0.9 },
  { route: "/download", priority: 0.9 },
  { route: "/changelog", priority: 0.7 },
  { route: "/terms", priority: 0.5 },
  ...docPages.map((page) => ({ route: page.href, priority: 0.8 })),
];

/** The routes that exist in English only. */
const ENGLISH_ONLY_ROUTES: readonly { route: string; priority: number }[] = [
  { route: "/app", priority: 0.9 },
  { route: "/blog", priority: 0.7 },
  ...posts.map((post) => ({ route: `/blog/${post.slug}`, priority: 0.6 })),
];

function absolute(locale: Locale, route: string): string {
  const path = localePath(locale, route);
  return path === "/" ? SITE_URL : `${SITE_URL}${path}`;
}

/** The alternates block one localised row carries: all five, then x-default. */
function languagesFor(route: string): Record<string, string> {
  const languages: Record<string, string> = {};
  for (const locale of LOCALES) languages[locale] = absolute(locale, route);
  languages["x-default"] = absolute("en", route);
  return languages;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const monthly = "monthly" as const;

  const localised = LOCALISED_ROUTES.flatMap(({ route, priority }) =>
    LOCALES.map((locale) => ({
      url: absolute(locale, route),
      lastModified,
      changeFrequency: monthly,
      priority,
      alternates: { languages: languagesFor(route) },
    })),
  );

  const englishOnly = ENGLISH_ONLY_ROUTES.map(({ route, priority }) => ({
    url: `${SITE_URL}${route}`,
    lastModified,
    changeFrequency: monthly,
    priority,
  }));

  return [...localised, ...englishOnly];
}
