import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { SiteHtml } from "@/components/site-html";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { reveal } from "@/lib/motion";
import { SITE_URL } from "@/lib/site";

/**
 * The 404 for a request that matched no route at all.
 *
 * WHY THIS FILE HAS TO EXIST
 * --------------------------
 * `html lang` has to be right per locale, so `app/[locale]/layout.tsx` is a root
 * layout, so there is no `app/layout.tsx`. Next then has no single document to
 * render a request time 404 inside, and falls back to an internal shell with no
 * markup in it: the right status code, and a blank page for anybody whose
 * JavaScript has not run. `global-not-found` is the answer Next provides for
 * exactly that, and it is why `experimental.globalNotFound` is on in
 * next.config.ts. It renders its own document, so nothing above it is needed.
 *
 * It is English. A URL that matched nothing has no locale to be wrong about, and
 * guessing one from a header is the thing this site does not do. A miss under a
 * locale that DOES exist, `/pt-BR/nope`, is answered in Portuguese by
 * app/[locale]/not-found.tsx instead.
 */

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  robots: { index: false, follow: true },
};

const linkClass = "focus-ring rounded text-accent transition-colors hover:text-accent-hover";

export default async function GlobalNotFound() {
  setRequestLocale(DEFAULT_LOCALE);
  const t = await getTranslations({ locale: DEFAULT_LOCALE, namespace: "notFound" });

  return (
    <SiteHtml locale={DEFAULT_LOCALE} localised={false}>
      <PageShell title={t("title")} lead={t("lead")}>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" {...reveal}>
          <Link href="/" className={linkClass}>
            {t("home")}
          </Link>
          <Link href="/docs" className={linkClass}>
            {t("docs")}
          </Link>
        </p>
      </PageShell>
    </SiteHtml>
  );
}
