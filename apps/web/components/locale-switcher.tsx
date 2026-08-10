"use client";

import { useLocale, useTranslations } from "next-intl";
import { LOCALES, LOCALE_FACES } from "@/i18n/locales";
import { Link, usePathname } from "@/i18n/navigation";
import { rememberLocale } from "@/lib/locale-choice";

/**
 * The language switcher, in the footer of every page that has translations.
 *
 * Flag, then the language's name written in that language. A reader looking for
 * Deutsch is looking for the word Deutsch, not for the word German.
 *
 * IT POINTS AT THIS PAGE, NEVER AT THE HOME PAGE
 * ----------------------------------------------
 * `usePathname` here is next-intl's, which reports the route with the locale
 * stripped off, so `/pt-BR/docs/cli` reads as `/docs/cli`. Feeding that back
 * through next-intl's `Link` puts the other locale's prefix on it. A reader four
 * pages deep who changes language stays four pages deep, which is the whole
 * point of the control and the thing most language menus get wrong.
 *
 * They are real anchors carrying `hrefLang`, not a script driven menu, so the
 * relationship between the five pages is visible to a crawler that never runs
 * the click handler.
 *
 * WHY THE CLICK WRITES A COOKIE
 * -----------------------------
 * Without it, a reader with a Portuguese cookie could never get to English: the
 * bare root would send them back to `/pt-BR` on the next visit, forever. Asking
 * for a language IS choosing it, so the choice is recorded here exactly as the
 * banner records it.
 */
export function LocaleSwitcher() {
  const current = useLocale();
  const pathname = usePathname();
  const t = useTranslations("localeSwitcher");

  return (
    <nav aria-label={t("label")} className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {LOCALES.map((locale) => {
        const face = LOCALE_FACES[locale];
        const active = locale === current;

        return (
          <Link
            key={locale}
            href={pathname}
            locale={locale}
            hrefLang={locale}
            onClick={() => rememberLocale(locale)}
            /* The current language is still a link rather than a dead span: it
               is the page it points at, so it is the one entry that can be
               trusted to work, and marking it `aria-current` says which it is
               without taking it out of the tab order. */
            aria-current={active ? "true" : undefined}
            className={`focus-ring inline-flex items-center gap-1.5 rounded py-0.5 transition-colors duration-200 ${
              active ? "text-heading" : "text-muted hover:text-heading"
            }`}
          >
            <span aria-hidden="true">{face.flag}</span>
            <span>{face.name}</span>
          </Link>
        );
      })}
    </nav>
  );
}
