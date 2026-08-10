"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LOCALE_FLAG_ICONS } from "@/components/flag-icons";
import { type Locale, isLocale } from "@/i18n/locales";
import { LOCALE_COOKIE, LOCALE_HINT_COOKIE, localePath } from "@/i18n/routing";
import { LOCALE_CHOSEN_EVENT, rememberLocale } from "@/lib/locale-choice";

/**
 * The offer, and the whole of decision 3's visible half.
 *
 * A reader whose browser asked for a language this site is published in is not
 * moved anywhere. They read the page they asked for, and this appears at the
 * bottom of it, written in the language on offer, with two ways to answer:
 * take it, or close it. Either answer is remembered, so it is asked once.
 *
 * IT CANNOT MOVE THE PAGE
 * -----------------------
 * Fixed to the bottom of the viewport, out of the flow, reserving no space. It
 * also mounts after hydration rather than being in the server's HTML, which is
 * the second half of the same promise: it is not in the first paint, so it is
 * not in the largest contentful paint either, and a page that never shows it is
 * byte for byte the page it was before this feature existed.
 *
 * WHY IT READS A COOKIE INSTEAD OF A HEADER
 * -----------------------------------------
 * Accept-Language is a request header, and a page that reads request headers is
 * a page Next has to render per request. This site is built once and served from
 * disk. The middleware sees the header, negotiates it, and leaves the answer on
 * `ol-lang-hint` for this component to read. See middleware.ts.
 */

export type LocaleOfferCopy = Record<Locale, { title: string; action: string; dismiss: string }>;

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match === null ? null : decodeURIComponent(match[1]);
}

export function LocaleOffer({ locale, copy }: { locale: Locale; copy: LocaleOfferCopy }) {
  const [offered, setOffered] = useState<Locale | null>(null);
  /* Next's `usePathname` rather than next-intl's, because this one needs the
     locale segment: it is stripped off below and replaced with the offered one.
     Reading it as state also matters more here than anywhere else on the site.
     This component is mounted once by the root layout and survives every client
     side navigation, so a link built from `window.location` at first render would
     still point at the first page a reader landed on three pages later. */
  const pathname = usePathname();

  useEffect(() => {
    /* Already answered, in either direction. The question is closed. Only a
       value we actually publish counts as an answer: the middleware ignores an
       invalid cookie, so the banner must too, or a stale value like `pt-br`
       from some earlier scheme mutes the offer forever with no way back. */
    if (isLocale(readCookie(LOCALE_COOKIE))) return;

    const hint = readCookie(LOCALE_HINT_COOKIE);
    if (!isLocale(hint)) return;

    /* The browser asked for the language it is already reading. Nothing to
       offer, and offering it anyway is how a banner becomes furniture. */
    if (hint === locale) return;

    setOffered(hint);
  }, [locale]);

  useEffect(() => {
    /* Any control recording a choice closes the question here too, in this
       tab, without waiting for a navigation this tab might never make. */
    const close = () => setOffered(null);
    window.addEventListener(LOCALE_CHOSEN_EVENT, close);
    return () => window.removeEventListener(LOCALE_CHOSEN_EVENT, close);
  }, []);

  if (offered === null) return null;

  const FlagIcon = LOCALE_FLAG_ICONS[offered];
  const words = copy[offered];

  /* The same page, in the offered language, never the home page. The locale
     segment, if there is one, comes off before the new one goes on. */
  const segments = pathname.split("/");
  if (isLocale(segments[1])) segments.splice(1, 1);
  const target = localePath(offered, segments.join("/") || "/");

  return (
    <div
      /* `fixed` and `pointer-events-none` on the positioner, with the card
         itself taking pointer events back: the strip spans the viewport for
         centring and does not swallow clicks on the page underneath it. */
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      /* Not `role="dialog"`: it takes no focus and traps none. It is an aside a
         reader may ignore entirely, and announcing it as a dialogue would be a
         claim about focus that is not true. */
      role="region"
      aria-label={words.title}
    >
      <div className="elev-1 pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border border-hairline bg-surface px-4 py-3 text-sm">
        <FlagIcon />
        <p className="min-w-0 text-soft">{words.title}</p>
        <a
          href={target}
          hrefLang={offered}
          onClick={(event) => {
            /* The reader's query string and fragment travel with them. Read at
               click time rather than render time, because both can change
               without a route change, and writing the href in the handler keeps
               this a real anchor that middle click and new tab still honour. */
            event.currentTarget.href = `${target}${window.location.search}${window.location.hash}`;
            rememberLocale(offered);
          }}
          className="focus-ring inline-flex flex-none items-center rounded-lg bg-accent-solid px-3 py-1.5 text-sm font-medium text-on-accent transition-colors duration-200 hover:bg-accent-solid-hover"
        >
          {words.action}
        </a>
        <button
          type="button"
          onClick={() => {
            /* Closing is an answer too: this reader wants the language they are
               reading. Remembering it is what stops the offer returning on the
               next page and on the next visit. */
            rememberLocale(locale);
            setOffered(null);
          }}
          aria-label={words.dismiss}
          title={words.dismiss}
          className="focus-ring -mr-1 inline-flex flex-none items-center justify-center rounded-lg p-1.5 text-muted transition-colors duration-200 hover:text-heading"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
