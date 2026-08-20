import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { AnnouncementBar } from "@/components/announcement-bar";
import { Footer } from "@/components/footer";
import { LocaleOffer, type LocaleOfferCopy } from "@/components/locale-offer";
import { Nav } from "@/components/nav";
import { Reveal } from "@/components/reveal";
import { ScrollTop } from "@/components/scroll-top";
import { LOCALES, type Locale } from "@/i18n/locales";
import { announceArmScript } from "@/lib/announce";
import { markArmScript } from "@/lib/brand";
import { wordmarkFont } from "@/lib/fonts";
import { motionArmScript } from "@/lib/motion";
import { themeArmScript } from "@/lib/theme";
import "@/app/globals.css";

/**
 * The document, in one place, for all three root layouts.
 *
 * WHY THERE ARE THREE ROOT LAYOUTS
 * -------------------------------
 * `html lang` has to say the truth about the page, and a Next layout can only
 * know the locale if the locale is in its own segment, which means
 * `app/[locale]/layout.tsx` has to be the topmost layout for a localised page.
 * Next allows more than one topmost layout only when there is no
 * `app/layout.tsx` above them, so that file is gone and each tree now renders
 * its own document element: the localised marketing site, the web application,
 * and the blog.
 *
 * Three documents is only a good trade if there is still one definition of what
 * a document is, which is this file. Every root layout is a few lines that hand
 * it a locale and some children. Nothing about the chrome can drift between
 * them, because there is nowhere for it to drift to.
 *
 * WHAT REACHES THE CLIENT
 * -----------------------
 * The provider is handed five namespaces rather than the whole catalog. The site
 * is server rendered almost everywhere, and the handful of components that do
 * hydrate need labels for a menu, a toggle, a dismiss button and a language
 * list. Serialising every documentation page's prose into the HTML so a theme
 * button can read two words would add weight to every page on the site for
 * nothing.
 */

const CLIENT_NAMESPACES = [
  "common",
  "nav",
  "announce",
  "localeSwitcher",
  "proPortal",
] as const;

/**
 * The offer banner's copy, in every language, gathered at build time.
 *
 * The banner is the one thing on the site written in a language the page is not
 * in: it appears on an English page to offer German, so it cannot read the
 * English page's catalog. Rather than inventing a second home for those strings,
 * the catalogs are read here, at build time, and the three lines per locale ride
 * down as a prop. Fifteen short strings, no request, no second source of truth.
 */
async function localeOfferCopy(): Promise<LocaleOfferCopy> {
  const entries = await Promise.all(
    LOCALES.map(async (locale) => {
      const t = await getTranslations({ locale, namespace: "localeOffer" });
      return [locale, { title: t("title"), action: t("action"), dismiss: t("dismiss") }] as const;
    }),
  );
  return Object.fromEntries(entries) as LocaleOfferCopy;
}

export async function SiteHtml({
  locale,
  children,
  /**
   * Off for the two English only trees. A switcher on the dashboard would
   * offer a Portuguese dashboard that does not exist, and decision 4 is that the
   * control points at the same page in another language or it does not appear.
   */
  localised = true,
}: Readonly<{ locale: Locale; children: ReactNode; localised?: boolean }>) {
  const messages = await getMessages({ locale });
  const t = await getTranslations({ locale, namespace: "common" });

  const clientMessages = Object.fromEntries(
    CLIENT_NAMESPACES.map((namespace) => [namespace, messages[namespace]]),
  );

  const offer = localised ? await localeOfferCopy() : null;

  return (
    /* The display face is published as a custom property on the root element,
       which is what lets app/globals.css set every heading in it without a
       class on each one, and what lets the dashboard's own stylesheet reach
       the same loaded file. See lib/fonts.ts: it is loaded once. */
    <html lang={locale} className={wordmarkFont.variable} suppressHydrationWarning>
      {/* This is a shared root layout head. The App Router expects a literal
          `<head>` here. `next/head` is the Pages Router API and would be wrong.
          The element lives in this component because three root layouts share
          one document. */}
      <head>
        {/* Applies a stored theme choice before first paint. See lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: themeArmScript }} />
        {/* Decides whether the mark draws itself in on this load. See lib/brand.ts. */}
        <script dangerouslySetInnerHTML={{ __html: markArmScript }} />
        {/* Arms the scroll reveal, but only where it is safe. See lib/motion.ts. */}
        <script dangerouslySetInnerHTML={{ __html: motionArmScript }} />
        {/* Closes the announcement bar before it paints, for a reader who has
            already closed it once. See lib/announce.ts. */}
        <script dangerouslySetInnerHTML={{ __html: announceArmScript }} />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-body antialiased selection:bg-accent-subtle selection:text-heading">
        <NextIntlClientProvider locale={locale} messages={clientMessages}>
          <a
            href="#main"
            className="focus-ring sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:border focus:border-hairline focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-heading"
          >
            {t("skipToContent")}
          </a>
          <AnnouncementBar />
          {/* THE OVERLAP CELL. The header and the page share one grid cell, so
             the header floats over the fold without consuming a row and
             without any negative margin anywhere. Whether the announcement
             bar exists above or not, the header and the page begin at the
             same layout coordinate: nothing has to know the bar's height,
             which is the whole class of bug this replaces (four founder
             photographs, 2026-08-10 and 11, all of them a negative pull
             disagreeing with what sat above it). */}
          <div className="page-overlap">
            <Nav />
            {children}
          </div>
          <Footer localised={localised} />
          {/* The one client component the motion system has. See lib/motion.ts. */}
          <Reveal />
          {/* Offered after a viewport of scrolling, on every page. */}
          <ScrollTop />
          {/* Offered once, to a reader whose browser asked for a language this
              site is published in and who has never answered the question. It
              overlays the page and reserves no space. See components/locale-offer.tsx. */}
          {offer !== null && <LocaleOffer locale={locale} copy={offer} />}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
