import { Analytics } from "@vercel/analytics/next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations } from "next-intl/server";
import { Inter } from "next/font/google";
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
import { motionArmScript } from "@/lib/motion";
import { themeArmScript } from "@/lib/theme";
import "@/app/globals.css";

const inter = Inter({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--ol-font-inter",
  preload: true,
});

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
 * The provider is handed a short list of namespaces rather than the whole
 * catalog, and which list depends on which of the three trees is asking. The
 * site is server rendered almost everywhere: the big namespaces, `docs`
 * (59 KB) and `privacy` (15 KB) among them, are read by server components and
 * never reach this provider at all, whichever tree renders them. What this
 * split actually buys is smaller: the handful of components that do hydrate
 * need labels for a menu, a toggle, a dismiss button and a language list, and
 * `hub` (7.7 KB) is the one namespace among those that a marketing page or a
 * blog post never hydrates a component that reads from, the same way
 * `proPortal` (4.3 KB) is the one `/app` never does. Neither figure is large
 * on its own; the marketing side of it is still a real cut repeated across
 * every localised page the site serves. The `namespaces` prop is how each
 * root layout says which of these it actually needs; the default,
 * `MARKETING_CLIENT_NAMESPACES`, is what every localised page and the blog
 * use unmodified, and `/app` passes its own shorter list from
 * app/app/layout.tsx.
 */

export const MARKETING_CLIENT_NAMESPACES = [
  "common",
  "nav",
  "announce",
  "localeSwitcher",
  "proPortal",
  "signIn",
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
      return [
        locale,
        { title: t("title"), action: t("action"), dismiss: t("dismiss") },
      ] as const;
    })
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
  /**
   * WHERE THE PAGE VIEW COUNT IS ALLOWED TO RUN, AND WHERE IT IS NOT.
   *
   * The website counts page views. The product does not send anything, and the
   * dashboard at /app is the product: it runs the same engine as the command
   * line tool, in the reader's own tab, on a document they never upload. The
   * download page and the privacy policy both promise that the web app sends
   * nothing, so a counter on that route would make this site a liar in the one
   * place it can least afford to be one.
   *
   * So the marketing pages and the blog carry the counter, and `/app` sets this
   * to false. It is cookieless either way: Vercel Web Analytics identifies no
   * one, sets no cookie and builds no profile, which is what lets the privacy
   * page describe it in one honest sentence.
   */
  analytics = true,
  namespaces = MARKETING_CLIENT_NAMESPACES,
}: Readonly<{
  locale: Locale;
  children: ReactNode;
  localised?: boolean;
  analytics?: boolean;
  /** Which message namespaces this tree hydrates with. See the note above. */
  namespaces?: readonly string[];
}>) {
  const messages = await getMessages({ locale });
  const t = await getTranslations({ locale, namespace: "common" });

  const clientMessages = Object.fromEntries(
    namespaces.map((namespace) => [namespace, messages[namespace]])
  );

  const offer = localised ? await localeOfferCopy() : null;

  return (
    <html lang={locale} className={inter.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-canvas font-sans text-body antialiased selection:bg-accent-subtle selection:text-heading">
        {/* These synchronous scripts are the first body children, before any
            visible content, so stored presentation state is applied before
            paint without maintaining a hand written document head. */}
        <script dangerouslySetInnerHTML={{ __html: themeArmScript }} />
        <script dangerouslySetInnerHTML={{ __html: markArmScript }} />
        <script dangerouslySetInnerHTML={{ __html: motionArmScript }} />
        <script dangerouslySetInnerHTML={{ __html: announceArmScript }} />
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
          {analytics && <Analytics />}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
