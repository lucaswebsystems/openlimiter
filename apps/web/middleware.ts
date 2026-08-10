import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { DEFAULT_LOCALE, LOCALES, isLocale, negotiateLocale } from "./i18n/locales";
import {
  LOCALE_COOKIE,
  LOCALE_HINT_COOKIE,
  LOCALE_HINT_MAX_AGE,
  isUnlocalisedRoute,
  routing,
} from "./i18n/routing";

/**
 * The one request time decision this site makes.
 *
 * Everything else here is a file on disk built once. This runs on the edge in
 * front of those files and does three things, in this order, and nothing else.
 *
 *   1. Gets out of the way of the three trees that are not localised.
 *   2. Sends a returning reader who has chosen a language to that language, at
 *      the bare root only.
 *   3. Notes what Accept-Language asked for, with a country fallback when it
 *      names no published language, so the offer banner can use that language.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never redirects on a browser language. A reader who lands on `/download`
 * with a German browser reads English and is offered German. That offer is a
 * banner they can take or close, and either way their answer is remembered.
 * Guessing and moving them would be the same mistake as guessing and moving
 * them back, and it breaks a shared link for everybody it is shared with.
 */

/**
 * next-intl's own middleware, doing the part that has to match the router
 * exactly: rewriting `/download` to the prerendered `/en/download`, redirecting
 * `/en/download` back to `/download` so English has one URL, and leaving a
 * `/pt-BR/download` alone. Writing that by hand next to `localePrefix:
 * 'as-needed'` would mean two implementations of one rule.
 */
const intlMiddleware = createMiddleware(routing);

const COUNTRY_TO_LOCALE: Partial<Record<string, (typeof LOCALES)[number]>> = {
  BR: "pt-BR",
  ES: "es",
  MX: "es",
  AR: "es",
  CO: "es",
  CL: "es",
  PE: "es",
  UY: "es",
  PY: "es",
  BO: "es",
  EC: "es",
  VE: "es",
  GT: "es",
  CR: "es",
  PA: "es",
  DO: "es",
  HN: "es",
  NI: "es",
  SV: "es",
  DE: "de",
  AT: "de",
  JP: "ja",
};

function localeFromCountry(country: string | null): (typeof LOCALES)[number] | null {
  if (country === null) return null;
  return COUNTRY_TO_LOCALE[country.toUpperCase()] ?? null;
}

/**
 * A locale segment spelled in the wrong case.
 *
 * `pt-BR` is the canonical spelling and the one the router matches, so `/pt-br`
 * would otherwise be treated as an ordinary path, rewritten to `/en/pt-br` and
 * returned as a 404. A reader typing a URL, or a link written by hand in someone
 * else's article, gets sent to the right page instead.
 */
function canonicalCaseLocale(segment: string): string | null {
  if (segment === "") return null;
  const lowered = segment.toLowerCase();
  const match = LOCALES.find((locale) => locale.toLowerCase() === lowered);
  return match !== undefined && match !== segment ? match : null;
}

export default function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  /*
    THE MOST LOAD BEARING LINE IN THIS FILE.

    The three English only trees must not be rewritten into `app/[locale]`. Hand
    `/blog` to the rewrite and it becomes `/en/blog`, a route that does not
    exist, and the blog returns 404 in production and nowhere else. The list
    lives in i18n/routing.ts because the link component has to obey it too.
  */
  if (isUnlocalisedRoute(pathname)) return NextResponse.next();

  const segments = pathname.split("/");
  const recased = canonicalCaseLocale(segments[1] ?? "");
  if (recased !== null) {
    const url = request.nextUrl.clone();
    segments[1] = recased;
    url.pathname = segments.join("/");
    return NextResponse.redirect(url);
  }

  const chosen = request.cookies.get(LOCALE_COOKIE)?.value;

  /*
    The returning reader, at the bare root only.

    They have been here, they picked a language, and they typed the naked domain
    or followed a link to it. That is the one request where guessing is not
    guessing, so it is the one request that moves.

    A deep link is left exactly where it points. Somebody sharing
    openlimiter.com/docs/cli is sharing the English page, and a cookie on the
    machine at the other end is not a reason to serve something else.
  */
  if (pathname === "/" && isLocale(chosen) && chosen !== DEFAULT_LOCALE) {
    const url = request.nextUrl.clone();
    url.pathname = `/${chosen}`;
    return NextResponse.redirect(url);
  }

  const response = intlMiddleware(request);

  /*
    The hint, and the only thing Accept-Language and country are used for here.

    Written only while the reader has never chosen, because that is exactly when
    the banner is allowed to appear. Once `NEXT_LOCALE` exists the question has
    been answered and the hint is cleared, so a stale answer cannot bring the
    banner back on the next visit.
  */
  if (!isLocale(chosen)) {
    const negotiated = negotiateLocale(request.headers.get("accept-language"));
    /* `null` means no published language matched. An explicit English match
       must win even though English is also the default locale. */
    const preferred =
      negotiated ?? localeFromCountry(request.headers.get("x-vercel-ip-country"));
    if (preferred !== null) {
      response.cookies.set(LOCALE_HINT_COOKIE, preferred, {
        path: "/",
        sameSite: "lax",
        maxAge: LOCALE_HINT_MAX_AGE,
        /* Read by the banner in the browser, so not httpOnly. It carries a
           language code and nothing else: no identifier, nothing personal, and
           nothing that leaves the machine. */
        httpOnly: false,
      });
    }
  } else if (request.cookies.has(LOCALE_HINT_COOKIE)) {
    response.cookies.delete(LOCALE_HINT_COOKIE);
  }

  return response;
}

export const config = {
  /*
    Everything except the things that are not pages.

    The negative lookahead keeps the edge out of the way of Next's own assets,
    the metadata routes that are files rather than pages, and anything in
    `public/` with a file extension on it. A middleware invocation in front of a
    font buys nothing and costs a hop.
  */
  matcher: [
    "/((?!_next/|api/|.*\\..*|icon|apple-icon|opengraph-image|twitter-image|sitemap\\.xml|robots\\.txt).*)",
  ],
};
