import { defineRouting } from "next-intl/routing";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./locales";

/**
 * How a locale reaches the URL.
 *
 * `as-needed` is what keeps English at the bare root: `/download` is English and
 * `/pt-BR/download` is Portuguese, and there is no `/en/download` for a reader
 * to land on, because the middleware redirects that spelling back to the
 * unprefixed one. One page, one URL, in every language.
 *
 * The two switches that are off are off because decision 3 says so, not as
 * tuning.
 *
 * `localeDetection: false` stops next-intl redirecting a visitor to a language
 * it guessed from a header. Nothing on this site ever moves a reader off the
 * URL they asked for because of Accept-Language. What the header does earn is an
 * offer, in a banner, which the reader can take or close. See middleware.ts.
 *
 * `localeCookie: false` stops next-intl writing `NEXT_LOCALE` on its own.
 * That cookie has exactly one meaning here, "this reader chose this language",
 * and a cookie written by merely arriving somewhere would destroy it: the offer
 * banner appears only while the cookie is absent, so a cookie nobody chose is a
 * banner nobody is ever offered. It is written by a click and by nothing else.
 */
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed",
  localeDetection: false,
  localeCookie: false,
});

/** The cookie holding a reader's own choice of language. Written by a click. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/**
 * The cookie carrying what Accept-Language said, for the offer banner to read.
 *
 * A static page cannot read a request header: calling `headers()` in a page is
 * what turns a prerendered file into a rendered one, and this site is meant to
 * be built once and served from disk. So the middleware, which does see the
 * header, writes its conclusion here, and the banner reads it on the client.
 *
 * It is a hint and nothing else. It never decides which page is served.
 */
export const LOCALE_HINT_COOKIE = "ol-lang-hint";

/**
 * How long the hint is worth keeping. Long enough to survive a reader clicking
 * around the site before deciding, short enough that a borrowed machine or a
 * changed browser setting is not remembered for a season.
 */
export const LOCALE_HINT_MAX_AGE = 60 * 60 * 24;

/** A year, which is what a deliberate choice of language deserves. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The two trees that exist in English only.
 *
 * They live outside `app/[locale]`, so a locale prefix in front of any of them
 * is a 404. Two places have to know that and they both read it from here: the
 * middleware, which must not rewrite them into the localised tree, and
 * components/site-link.tsx, which must not put a prefix on a link to one.
 *
 * A new English only tree is added here in the same commit that creates it, or
 * it breaks in Portuguese and nowhere else.
 */
export const UNLOCALISED_PREFIXES = ["/app", "/blog"] as const;

export function isUnlocalisedRoute(pathname: string): boolean {
  return UNLOCALISED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * A route, in a locale.
 *
 * Every canonical URL, every `hreflang` alternate, every sitemap row and every
 * link the switcher builds comes from this one function, so the three surfaces
 * that have to agree about where a page lives cannot drift apart.
 *
 * `route` is always the English pathname with a leading slash and no locale on
 * it, which is also how the routes are spelled on disk. The segments themselves
 * are not translated this wave: see PLAN.md, section 11.
 */
export function localePath(locale: Locale, route: string): string {
  const path = route === "/" ? "" : route;
  return locale === DEFAULT_LOCALE ? path || "/" : `/${locale}${path}`;
}
