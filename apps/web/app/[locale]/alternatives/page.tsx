import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { SiteLink } from "@/components/site-link";
import { Card } from "@/components/ui";
import { alternatives } from "@/lib/alternatives";
import { pageMetadata } from "@/lib/metadata";
import { reveal, revealGroup } from "@/lib/motion";
import { getTranslations } from "next-intl/server";
import { type LocaleParams, pageLocale } from "@/i18n/params";

/**
 * /alternatives
 *
 * The index of the comparison pages. Every entry comes from lib/alternatives.ts,
 * which keeps the slug, the name and the url, and hands the sentences to
 * `alternatives.entries.<slug>` in the catalog. The rule there is that each
 * tool's genuine strength is written before any difference is described, and
 * several of these tools are more mature than this one.
 *
 * The note about when and how these were checked sits above the grid rather
 * than under it, because a reader deciding whether to trust a comparison needs
 * that before they read the comparison, not after.
 */

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "alternatives" });

  return pageMetadata({
    title: t("metaTitle"),
    description: t("metaDescription"),
    route: "/alternatives",
    locale,
  });
}

export default async function AlternativesPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("alternatives");

  return (
    <PageShell title={t("title")} lead={t("lead")}>
      <Card className="max-w-xl">
        <p className="font-mono text-2xs uppercase tracking-widest text-muted">
          {t("checkedTitle")}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-body">{t("note")}</p>
      </Card>

      <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2" {...revealGroup}>
        {alternatives.map((entry) => (
          <SiteLink
            key={entry.slug}
            href={`/alternatives/${entry.slug}`}
            className="focus-ring flex h-full flex-col rounded-xl border border-hairline bg-surface p-6 transition-colors hover:bg-raised"
            {...reveal}
          >
            <h2 className="text-xl font-medium text-heading">{entry.name}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">
              {t(`entries.${entry.slug}.summary`)}
            </p>
            <p className="mt-auto pt-4 text-xs text-muted">{t("readComparison")}</p>
          </SiteLink>
        ))}
      </div>
    </PageShell>
  );
}
