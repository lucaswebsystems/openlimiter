"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { LOCALE_FLAG_ICONS } from "@/components/flag-icons";
import { LOCALES, LOCALE_FACES, type Locale } from "@/i18n/locales";
import { usePathname } from "@/i18n/navigation";
import { localePath } from "@/i18n/routing";
import { rememberLocale } from "@/lib/locale-choice";

/**
 * The language menu in the header (founder's order, 2026-10-01), beside the
 * theme toggle. It opens the same five links the footer switcher shows and
 * follows the same rules: real anchors with hrefLang to this very page in the
 * other language, and a click records the choice in the locale cookie.
 */
export function HeaderLocale() {
  const current = useLocale() as Locale;
  const pathname = usePathname();
  const t = useTranslations("localeSwitcher");
  const menu = useRef<HTMLDetailsElement | null>(null);
  const CurrentFlag = LOCALE_FLAG_ICONS[current];

  /* A details element stays open until toggled; close it on a click or focus
     outside, or on Escape (which hands focus back to the trigger), like any
     other disclosure menu. */
  useEffect(() => {
    const close = (event: Event) => {
      const element = menu.current;
      if (element === null || !element.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        element.open = false;
        element.querySelector("summary")?.focus();
      } else if (!element.contains(event.target as Node)) {
        element.open = false;
      }
    };
    document.addEventListener("click", close);
    document.addEventListener("focusin", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("focusin", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <details ref={menu} className="relative">
      <summary
        aria-label={t("label")}
        className="focus-ring inline-flex h-9 flex-none cursor-pointer list-none items-center gap-1.5 rounded-lg border border-hairline-strong px-2.5 text-sm text-heading transition-colors hover:border-heading hover:bg-surface"
      >
        <CurrentFlag />
        <span>{current === "pt-BR" ? "PT" : current.toUpperCase()}</span>
      </summary>
      <nav
        aria-label={t("label")}
        className="absolute right-0 top-full z-50 mt-2 flex min-w-44 flex-col rounded-xl border border-hairline-strong bg-raised p-1.5 text-left shadow-lg"
      >
        {LOCALES.map((locale) => {
          const FlagIcon = LOCALE_FLAG_ICONS[locale];
          const href = localePath(locale, pathname);
          return (
            <a
              key={locale}
              href={href}
              hrefLang={locale}
              aria-current={locale === current ? "true" : undefined}
              onClick={(event) => {
                event.currentTarget.href = `${href}${window.location.search}${window.location.hash}`;
                rememberLocale(locale);
              }}
              className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-surface ${locale === current ? "font-medium text-heading" : "text-body"}`}
            >
              <FlagIcon />
              <span>{LOCALE_FACES[locale].name}</span>
            </a>
          );
        })}
      </nav>
    </details>
  );
}
