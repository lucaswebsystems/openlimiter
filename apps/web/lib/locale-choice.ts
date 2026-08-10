import type { Locale } from "@/i18n/locales";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, LOCALE_HINT_COOKIE } from "@/i18n/routing";

/**
 * Writing down a reader's choice of language.
 *
 * One function, called from the two controls that can express a choice: the
 * offer banner and the footer switcher. The middleware never writes this cookie
 * and neither does next-intl, which is what keeps its meaning exact. It says a
 * person decided, and it is the reason the banner is asked once rather than on
 * every page.
 *
 * The hint goes at the same time. It was the browser's opinion, and the browser's
 * opinion stops mattering the moment its owner states one.
 */
export function rememberLocale(locale: Locale): void {
  if (typeof document === "undefined") return;

  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
  document.cookie = `${LOCALE_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}
