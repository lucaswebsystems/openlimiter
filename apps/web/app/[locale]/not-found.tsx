import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { PageShell } from "@/components/page-shell";
import { reveal } from "@/lib/motion";

/**
 * The 404, in the reader's language.
 *
 * HOW IT KNOWS THE LANGUAGE
 * -------------------------
 * A `not-found` file cannot take `params`, which is normally where the locale
 * comes from. It does not need to: the boundary renders inside
 * `app/[locale]/layout.tsx`, and that layout has already called
 * `setRequestLocale` for this render, so asking for translations here resolves
 * against the locale of the URL that missed rather than against the default.
 *
 * The other half of that arrangement is `[locale]/[...rest]/page.tsx`, which is
 * what turns an unknown path under a locale into a call to `notFound()` with the
 * locale still in hand. Without it, an unknown path would fall through to the
 * document root and be answered in English.
 */

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
