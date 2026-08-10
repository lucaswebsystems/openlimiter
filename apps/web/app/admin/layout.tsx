import type { Metadata, Viewport } from "next";
import { setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { SiteHtml } from "@/components/site-html";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { SITE_URL, TITLE_SUFFIX } from "@/lib/site";

/**
 * The founder console's own document.
 *
 * It exists because the site is published in five languages: `html lang` has to
 * be right per locale, so the localised tree owns the root layout, so
 * `app/layout.tsx` is gone and every other top level tree renders its own
 * document. This is that, for one page, through the same component.
 *
 * The console is English and internal. The switcher is suppressed, the page
 * itself is noindexed and absent from the sitemap, and the middleware leaves
 * `/admin` out of the localised rewrite.
 */

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Admin", template: `%s${TITLE_SUFFIX}` },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  setRequestLocale(DEFAULT_LOCALE);

  return (
    <SiteHtml locale={DEFAULT_LOCALE} localised={false}>
      {children}
    </SiteHtml>
  );
}
