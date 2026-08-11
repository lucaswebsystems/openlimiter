"use client";

import { useTranslations } from "next-intl";
import { ANNOUNCE_ATTR, ANNOUNCE_OFF } from "@/lib/announce";

/**
 * The close control, and the only client side code the bar has.
 *
 * It writes the choice and sets the attribute the stylesheet reads. The bar
 * itself stays a server component, so nothing about the sentence, the link or
 * the layout depends on JavaScript having run, and a browser that refuses
 * storage simply keeps the bar rather than throwing.
 *
 * Nothing is unmounted here. Hiding through the root attribute is what keeps
 * the server markup and the client tree identical, so there is no hydration
 * mismatch and no second paint of a bar that was already closed.
 */
export function AnnouncementDismiss() {
  const t = useTranslations("announce");
  function dismiss() {
    /* Closing hides the bar for THIS page only, by the founder's order
       (2026-08-11): the promo returns on the next load. Nothing is written
       to storage, so a reader who closed it once still sees it tomorrow. */
    document.documentElement.setAttribute(ANNOUNCE_ATTR, ANNOUNCE_OFF);
  }

  return (
    <button
      type="button"
      onClick={dismiss}
      aria-label={t("dismiss")}
      title={t("dismiss")}
      className="announce-dismiss focus-ring-inset -mr-1 inline-flex h-7 w-7 flex-none items-center justify-center rounded-md"
    >
      <svg
        viewBox="0 0 24 24"
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}
