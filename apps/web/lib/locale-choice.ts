import type { Locale } from "@/i18n/locales";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/i18n/routing";

/**
 * Writing down a reader's choice of language.
 *
 * One function, called from the two controls that can express a choice: the
 * offer banner and the footer switcher. The middleware never writes this cookie
 * and neither does next-intl, which is what keeps its meaning exact. It says a
 * person decided, and it is the reason the banner is asked once rather than on
 * every page. It is the only cookie the site writes before a phone is paired.
 *
 * The event tells the offer banner, in this tab, that the question was answered
 * by some other control. Cookies do not notify, and a banner that only reads
 * them on mount can outlive the choice it asked about: a switcher link opened
 * into a new tab records the answer while the old tab keeps offering.
 */
export const LOCALE_CHOSEN_EVENT = "ol:locale-chosen";

export function rememberLocale(locale: Locale): void {
  if (typeof document === "undefined") return;

  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  window.dispatchEvent(new CustomEvent(LOCALE_CHOSEN_EVENT));
}
