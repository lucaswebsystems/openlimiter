import { getTranslations } from "next-intl/server";
import { AnnouncementDismiss } from "./announcement-dismiss";
import { SiteLink } from "./site-link";
import { SHELL } from "./ui";
import { ANNOUNCE_HREF } from "@/lib/announce";

/**
 * The announcement bar.
 *
 * Thirty six pixels of brand blue at the very top of every marketing page,
 * above the header, carrying one sentence and a way to close it. It is a
 * server component: the markup is in the document the server sends, so it
 * paints with the rest of the page and never arrives late.
 *
 * Three rules it keeps.
 *
 * It never shifts the layout. A reader who closed it has the root attribute
 * set by the head script before first paint, and the rule in globals.css takes
 * the element out of the flow entirely, so the header rises into the space
 * rather than a blank strip being left behind.
 *
 * It never appears over the application. /app is the product surface, not a
 * marketing page, and the rule that hides it there is a plain CSS selector
 * against the shell that route already renders, so nothing about this bar is
 * wired into the application's own code.
 *
 * The blue is the same blue in both themes, deliberately, and the text on it is
 * white at 4.82:1, which clears AA for normal text. The focus ring inside the
 * bar is white too, because an accent coloured ring on an accent coloured band
 * is not a ring.
 */

function ChevronGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 flex-none transition-transform duration-200 group-hover:translate-x-0.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export async function AnnouncementBar() {
  const t = await getTranslations("announce");

  return (
    <div className="announce-bar bg-announce text-announce-fg">
      <div className={`${SHELL} flex h-9 items-center gap-2`}>
        <SiteLink
          href={ANNOUNCE_HREF}
          className="focus-ring-inset group flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded text-xs font-medium"
        >
          <span className="sr-only">{t("message")}</span>
          {/* A small spark on the left, drawn here: the promo is a founding
             offer rather than a warning, so the mark is celebratory and not a
             megaphone. Founder's ask (2026-08-11). */}
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5 flex-none"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 2.5l1.7 5.1 5.1 1.7-5.1 1.7L12 16.1l-1.7-5.1-5.1-1.7 5.1-1.7L12 2.5Z" />
            <path d="M18.5 15.2l.85 2.45 2.45.85-2.45.85-.85 2.45-.85-2.45-2.45-.85 2.45-.85.85-2.45Z" />
          </svg>
          {/* Two whole sentences rather than one sentence split across widths.
              It used to be spliced mid word, so a narrow screen could drop the
              first syllable and still open on a capital, and a word cut in half
              is a word no translator can be handed. Both are complete in every
              language, the visible pair is hidden from assistive technology, and
              the sentence a screen reader gets sits above them. */}
          <span aria-hidden="true" className="truncate">
            <span className="hidden sm:inline">{t("message")}</span>
            <span className="sm:hidden">{t("short")}</span>
          </span>
          <ChevronGlyph />
        </SiteLink>
        <AnnouncementDismiss />
      </div>
    </div>
  );
}
