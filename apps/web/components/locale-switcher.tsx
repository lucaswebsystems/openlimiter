"use client";

import { useLocale, useTranslations } from "next-intl";
import { LOCALE_FLAG_ICONS } from "@/components/flag-icons";
import { LOCALES, LOCALE_FACES } from "@/i18n/locales";
import { usePathname } from "@/i18n/navigation";
import { localePath } from "@/i18n/routing";
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
export function LocaleSwitcher({ vertical = false }: { vertical?: boolean }) {
  const current = useLocale();
  const pathname = usePathname();
  const t = useTranslations("localeSwitcher");

  return (
    <nav
      aria-label={t("label")}
      className={
        vertical
          ? "flex flex-col items-center gap-0.5 md:items-start"
          : "flex flex-wrap items-center gap-x-4 gap-y-1.5"
      }
    >
      {LOCALES.map((locale) => {
        const face = LOCALE_FACES[locale];
        const FlagIcon = LOCALE_FLAG_ICONS[locale];
        const active = locale === current;
        /* Built by hand rather than through next-intl's Link, because that Link
           spells English as `/en/...`, a URL the middleware exists to redirect
           away from: every switch to English would ride a 307 and the anchor
           would disagree with the page's own hreflang. `localePath` writes the
           canonical form directly, unprefixed English included. */
        const href = localePath(locale, pathname);

        return (
          <a
            key={locale}
            href={href}
            hrefLang={locale}
            onClick={(event) => {
              /* Query and fragment come along, read at click time. See the
                 same pattern on the offer banner. */
              event.currentTarget.href = `${href}${window.location.search}${window.location.hash}`;
              rememberLocale(locale);
            }}
            /* The current language is still a link rather than a dead span: it
               is the page it points at, so it is the one entry that can be
               trusted to work, and marking it `aria-current` says which it is
               without taking it out of the tab order. */
            aria-current={active ? "true" : undefined}
            className={`focus-ring inline-flex items-center gap-1.5 rounded py-0.5 transition-colors duration-200 ${
              active ? "text-heading" : "text-muted hover:text-heading"
            }`}
          >
            <FlagIcon />
            <span>{face.name}</span>
          </a>
        );
      })}
    </nav>
  );
}
