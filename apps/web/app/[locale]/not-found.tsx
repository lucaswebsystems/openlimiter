import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PageShell } from "@/components/page-shell";
import { reveal } from "@/lib/motion";
import { SITE_URL } from "@/lib/site";

/**
 * The 404 boundary for a page under a locale that calls `notFound()`.
 *
 * Today no matched route misses: every dynamic route pins its params. A URL that matches no
 * route at all does not reach here: it is answered by app/global-not-found.tsx,
 * which renders its own document.
 *
 * HOW IT KNOWS THE LANGUAGE
 * -------------------------
 * A `not-found` file cannot take `params`, which is normally where the locale
 * comes from. It does not need to: the boundary renders inside
 * `app/[locale]/layout.tsx`, and that layout has already called
 * `setRequestLocale` for this render, so asking for translations here resolves
 * against the locale of the URL that missed rather than against the default.
 *
 * KNOWN LIMITATION, AND IT IS NEXT'S
 * ----------------------------------
 * At build time this renders correctly. At request time Next 15.5 answers a
 * `notFound()` with an internal shell carrying the right status and no markup,
 * because there is no `app/layout.tsx` for it to render a 404 inside, and there
 * is none because `html lang` has to be right per locale. The status code is
 * correct either way and the content arrives on hydration. See PLAN.md.
 */

/* The boundary renders outside the layout's own metadata pass, so it states the
   base for relative URLs itself rather than inheriting one, and it declines to be
   indexed the way the root 404 does. */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  robots: { index: false, follow: true },
};

const linkClass =
  "focus-ring rounded text-accent transition-colors hover:text-accent-hover";

export default async function LocaleNotFound() {
  const t = await getTranslations("notFound");

  return (
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
  );
}
