import { setRequestLocale, getTranslations } from "next-intl/server";
import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { SiteHtml } from "@/components/site-html";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { reveal } from "@/lib/motion";

/**
 * The last resort 404, for a miss that belongs to no locale.
 *
 * Almost every miss on this site is answered by `app/[locale]/not-found.tsx` in
 * the reader's own language. What reaches here is a path in one of the three
 * English only trees, `/blog/does-not-exist` being the realistic example.
 *
 * It renders its own document rather than borrowing one, because there is no
 * `app/layout.tsx` any more: `html lang` has to vary per locale, so the localised
 * tree owns the root layout and every other entry point renders its own. Next
 * requires exactly this of a root `not-found` when a project has more than one
 * root layout.
 */

const linkClass =
  "focus-ring rounded text-accent transition-colors hover:text-accent-hover";

export default async function NotFound() {
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
