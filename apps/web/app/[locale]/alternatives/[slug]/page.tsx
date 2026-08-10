import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageShell, ShellSections } from "@/components/page-shell";
import { SiteLink } from "@/components/site-link";
import { ButtonLink, Card, SectionHeading } from "@/components/ui";
import { alternatives, findAlternative } from "@/lib/alternatives";
import { pageMetadata } from "@/lib/metadata";
import { getTranslations } from "next-intl/server";
import { pageLocale } from "@/i18n/params";
import { routing } from "@/i18n/routing";

/**
 * /alternatives/[slug]
 *
 * One comparison, in a fixed order that the data enforces: what the tool is,
 * what it does, what it does better than OpenLimiter, and only then where the
 * two differ. The link out to the project's own page sits near the top, next to
 * the facts, so a reader can go and check any of this before reading further.
 *
 * Every sentence comes from `alternatives.entries.<slug>` in the catalog and the
 * page's own labels from `alternatives.comparison.*`, so the only things read
 * from lib/alternatives.ts here are the slug, the name and the url.
 *
 * Next 15 hands `params` to a page as a promise, so both the page and the
 * metadata function await it before reading the slug.
 *
 * TWO SEGMENTS, NOT ONE
 * ---------------------
 * This route sits under `app/[locale]`, so it has two dynamic segments and the
 * static params are the cross product of both. Returning slugs alone would
 * prerender the five English pages and leave twenty translated ones to be
 * rendered on request.
 */

interface ComparisonParams {
  params: Promise<{ locale: string; slug: string }>;
}

/* The slug list is finite and known at build time, so an unknown slug is
   rejected before this route ever matches and the request falls through to
   global-not-found, which renders a real page. Without this, a request time
   notFound() from a matched route renders Next's markupless shell: a correct
   404 status wrapped around a blank screen for anyone without JavaScript. */
export const dynamicParams = false;

export function generateStaticParams() {
  return routing.locales.flatMap((locale) =>
    alternatives.map((entry) => ({ locale, slug: entry.slug })),
  );
}

export async function generateMetadata({ params }: ComparisonParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const { slug } = await params;
  const entry = findAlternative(slug);
  const t = await getTranslations({ locale, namespace: "alternatives" });
  if (entry === undefined) return { title: t("comparison.notFound") };

  return pageMetadata({
    title: t("comparison.metaTitle", { name: entry.name }),
    description: t(`entries.${slug}.summary`),
    route: `/alternatives/${slug}`,
    locale,
  });
}

export default async function AlternativePage({ params }: ComparisonParams) {
  await pageLocale(params);
  const { slug } = await params;
  const entry = findAlternative(slug);
  if (entry === undefined) notFound();

  const t = await getTranslations("alternatives");

  const index = alternatives.indexOf(entry);
  const previous = index > 0 ? alternatives[index - 1] : undefined;
  const next = index < alternatives.length - 1 ? alternatives[index + 1] : undefined;

  /* The four facts, in the order a reader checks them. Each one is a term from
     the shared `facts` labels and an answer from this entry's own key, so the
     pair is read from the catalog under one name and cannot drift apart. */
  const facts = ["platform", "licence", "coverage", "source"] as const;

  return (
    <PageShell
      title={t("comparison.title", { name: entry.name })}
      lead={t(`entries.${slug}.summary`)}
    >
      <dl className="grid max-w-3xl grid-cols-1 gap-6 rounded-xl border border-hairline bg-surface p-6 sm:grid-cols-2">
        {facts.map((fact) => (
          <div key={fact}>
            <dt className="text-xs uppercase tracking-widest text-muted">{t(`facts.${fact}`)}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-body">
              {t(`entries.${slug}.${fact}`)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-6">
        <ButtonLink href={entry.url} external>
          {t("comparison.visit", { name: entry.name })}
        </ButtonLink>
      </div>

      <div className="mt-24">
        <ShellSections>
          <section>
            <SectionHeading id="what-it-does" title={t("comparison.whatItDoes")} />
            <p className="mx-auto max-w-[70ch] text-center text-base leading-relaxed text-soft">
              {t(`entries.${slug}.what`)}
            </p>
          </section>

          <section>
            <SectionHeading id="strength" title={t("comparison.strength")} />
            <p className="mx-auto max-w-[70ch] text-center text-base leading-relaxed text-soft">
              {t(`entries.${slug}.strength`)}
            </p>
          </section>

          <section>
            <SectionHeading id="difference" title={t("comparison.difference")} />
            <p className="mx-auto max-w-[70ch] text-center text-base leading-relaxed text-soft">
              {t(`entries.${slug}.difference`)}
            </p>
          </section>

          <div className="max-w-xl space-y-4">
            {t.has(`entries.${slug}.caveat`) && (
              <Card>
                <p className="font-mono text-2xs uppercase tracking-widest text-muted">
                  {t("comparison.caveatTitle")}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-body">
                  {t(`entries.${slug}.caveat`)}
                </p>
              </Card>
            )}

            <Card>
              <p className="font-mono text-2xs uppercase tracking-widest text-muted">
                {t("checkedTitle")}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-body">{t("note")}</p>
            </Card>
          </div>
        </ShellSections>
      </div>

      <nav
        aria-label={t("comparison.nav.label")}
        className="mt-16 flex flex-wrap items-start justify-between gap-6 border-t border-hairline pt-6"
      >
        {previous !== undefined ? (
          <SiteLink href={`/alternatives/${previous.slug}`} className="focus-ring rounded">
            <span className="block text-xs uppercase tracking-widest text-muted">
              {t("comparison.nav.previous")}
            </span>
            <span className="mt-1 block text-sm text-accent">{previous.name}</span>
          </SiteLink>
        ) : (
          <SiteLink href="/alternatives" className="focus-ring rounded">
            <span className="block text-xs uppercase tracking-widest text-muted">
              {t("comparison.nav.back")}
            </span>
            <span className="mt-1 block text-sm text-accent">{t("comparison.nav.all")}</span>
          </SiteLink>
        )}

        {next !== undefined && (
          <SiteLink
            href={`/alternatives/${next.slug}`}
            className="focus-ring ml-auto rounded text-right"
          >
            <span className="block text-xs uppercase tracking-widest text-muted">
              {t("comparison.nav.next")}
            </span>
            <span className="mt-1 block text-sm text-accent">{next.name}</span>
          </SiteLink>
        )}
      </nav>
    </PageShell>
  );
}
