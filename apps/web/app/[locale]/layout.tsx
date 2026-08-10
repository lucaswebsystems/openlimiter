import type { Metadata, Viewport } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SiteHtml } from "@/components/site-html";
import { LOCALE_FACES } from "@/i18n/locales";
import { localePath, routing } from "@/i18n/routing";
import { localeAlternates } from "@/lib/metadata";
import {
  AUTHOR_NAME,
  AUTHOR_SITE,
  SITE_NAME,
  SITE_URL,
  TITLE_SUFFIX,
} from "@/lib/site";

/**
 * The root layout for every localised page: the marketing site and the
 * documentation, in five languages.
 *
 * It is a root layout rather than a nested one because it is the shallowest
 * place that knows the locale, and `html lang` has to be right. What that costs
 * and what it buys is written out in components/site-html.tsx.
 */

/**
 * The five pages Next builds for every route beneath this layout.
 *
 * This is what makes the whole site static in five languages: the locale is a
 * build time parameter, not a runtime one, so `/pt-BR/docs/cli` is a file on
 * disk exactly as `/docs/cli` is. English is generated here too, at `/en/...`,
 * and reaches the reader unprefixed because the middleware rewrites to it. See
 * i18n/routing.ts.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const t = await getTranslations({ locale, namespace: "meta" });
  const title = t("title");
  const description = t("description");

  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: title,
      template: `%s${TITLE_SUFFIX}`,
    },
    description,
    applicationName: SITE_NAME,
    /* The home page's own canonical and its five alternates. Every page under
       this layout sets its own; this is the one for `/` itself. */
    alternates: localeAlternates("/", locale),
    authors: [{ name: AUTHOR_NAME, url: AUTHOR_SITE }],
    creator: AUTHOR_NAME,
    publisher: SITE_NAME,
    keywords: [
      "AI coding agents",
      "quota awareness",
      "Claude Code",
      "Codex CLI",
      "OpenCode",
      "open source",
      "local first",
    ],
    openGraph: {
      type: "website",
      url: localePath(locale, "/"),
      siteName: SITE_NAME,
      title,
      description,
      locale: LOCALE_FACES[locale].ogLocale,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    robots: {
      index: true,
      follow: true,
    },
  };
}

export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{ children: ReactNode; params: Promise<{ locale: string }> }>) {
  const { locale } = await params;

  /* A segment that is not one of the five is not a language, it is a 404. This
     is also what narrows the type for everything below. */
  if (!hasLocale(routing.locales, locale)) notFound();

  /* Without this, every page under here reads its messages through a request
     and Next has to render them per request. With it, they are prerendered.
     It is the one line the whole static promise rests on, and it has to be
     called in every layout and page that reads copy. */
  setRequestLocale(locale);

  return <SiteHtml locale={locale}>{children}</SiteHtml>;
}
