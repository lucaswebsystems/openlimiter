import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { Locale } from "./locales";
import { routing } from "./routing";

/**
 * What every localised page and layout does with its first line.
 *
 * Three obligations arrive together on every route under `app/[locale]`, and
 * missing any one of them fails quietly rather than loudly, which is why they
 * are one call rather than three:
 *
 *   the segment has to be checked, because `[locale]` matches any string and
 *   `/klingon/download` is a 404 rather than a language;
 *
 *   `setRequestLocale` has to be called, or the page reads its copy through a
 *   request and Next renders it per request instead of prerendering it, which
 *   is the whole static promise gone with no error to show for it;
 *
 *   the string has to be narrowed to `Locale` before anything typed can be done
 *   with it.
 *
 * A page that starts with `const locale = await pageLocale(params)` has done all
 * three and can get on with rendering.
 */

/** The props shape of any page or layout under `app/[locale]`. */
export interface LocaleParams {
  params: Promise<{ locale: string }>;
}

export async function pageLocale(params: Promise<{ locale: string }>): Promise<Locale> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return locale;
}
