import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";

/**
 * Every path under a locale that is not a page.
 *
 * It exists for one reason: to answer a miss in the language of the URL that
 * missed. `not-found.tsx` cannot read `params`, so without this file an unknown
 * path would reach the document root with no locale in scope and be answered in
 * English under a `lang="en"` document, whatever the reader had asked for.
 *
 * A concrete route always wins over a catch all in Next's matcher, so this only
 * ever sees paths nothing else claimed. It renders on demand rather than at build
 * time, which is correct: the set of URLs that do not exist cannot be enumerated,
 * and a 404 is not a page anybody measures the speed of.
 */
export default async function LocaleCatchAll({
  params,
}: {
  params: Promise<{ locale: string; rest: string[] }>;
}) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);

  notFound();
}
