import { hasLocale } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/json-ld";
import { SiteLink } from "@/components/site-link";
import { routing } from "@/i18n/routing";
import { docNeighbours, findDocPageById } from "@/lib/docs";
import { docsBreadcrumbSchema } from "@/lib/jsonld";
import { reveal, revealGroup, revealSm } from "@/lib/motion";

export interface DocSection {
  /** Anchor id. Also the target of the on this page list. */
  id: string;
  title: string;
  body: ReactNode;
}

/**
 * The shell every documentation page renders inside.
 *
 * Sections arrive as one typed list, so the headings, the anchors, and the on
 * this page list are generated from the same source and cannot drift apart.
 * Heading order is fixed here: one h1 for the page, one h2 per section, and any
 * h3 lives inside a section body.
 *
 * The BreadcrumbList structured data is emitted here rather than on each page,
 * beside the trail a reader can see, and both are built from the route this
 * component already knows. A page cannot show one trail and declare another.
 *
 * IT TAKES AN IDENTIFIER, NOT A TITLE
 * -----------------------------------
 * Each page used to hand in its own `href`, `title` and `lead`, which meant the
 * title existed twice: once here and once in the documentation map that draws
 * the sidebar and the previous and next links. In five languages that would have
 * been ten copies of every heading. Now a page says which page it is, and the
 * route comes from the map while the words come from the catalog under
 * `docs.pages.<id>`.
 */
export async function DocArticle({
  id,
  sections,
}: {
  /** The page's key in lib/docs.ts and in `docs.pages` in the catalogs. */
  id: string;
  sections: readonly DocSection[];
}) {
  const page = findDocPageById(id);
  if (page === undefined) throw new Error(`Unknown documentation page: ${id}`);

  const href = page.href;
  /* `getLocale` is typed as a plain string, so it is narrowed here rather than
     cast. It cannot fail in practice: this component only renders under
     app/[locale], whose layout has already rejected anything that is not one of
     the five. The default is the answer to a question that never gets asked. */
  const requested = await getLocale();
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const t = await getTranslations("docs");
  const routes = await getTranslations("common.routes");
  const title = t(`pages.${id}.title`);
  const lead = t(`pages.${id}.lead`);
  const { previous, next } = docNeighbours(href);

  return (
    <div className="flex gap-12">
      <article className="min-w-0 max-w-3xl flex-1 pb-20">
        <JsonLd data={await docsBreadcrumbSchema(href, locale)} />
        {/* The page header arrives as one group: trail, title, lead, 70ms
            apart. The wrapper carries no styling of its own, so the rhythm the
            margins below set is untouched. */}
        <div {...revealGroup}>
          <nav aria-label={t("article.breadcrumb")} {...revealSm}>
            <ol className="flex items-center gap-2 font-mono text-2xs uppercase tracking-widest text-muted">
              <li>
                <SiteLink
                  href="/docs"
                  className="focus-ring rounded transition-colors hover:text-heading"
                >
                  {routes("docs")}
                </SiteLink>
              </li>
              <li aria-hidden="true">/</li>
              <li className="text-heading">{title}</li>
            </ol>
          </nav>

          <h1
            className="mt-5 font-sans text-3xl font-medium tracking-tight text-heading sm:text-4xl"
            {...reveal}
          >
            {title}
          </h1>
          <p className="mt-4 font-sans text-base leading-8 text-body" {...reveal}>
            {lead}
          </p>
        </div>

        {sections.map((section) => (
          <section key={section.id} className="mt-14" {...reveal}>
            <h2
              id={section.id}
              className="scroll-mt-24 border-t border-hairline pt-8 font-sans text-xl font-medium tracking-tight text-heading"
            >
              {section.title}
            </h2>
            {section.body}
          </section>
        ))}

        {(previous !== null || next !== null) && (
          <nav
            aria-label={t("article.pagesNav")}
            className="mt-16 grid grid-cols-1 gap-4 border-t border-hairline pt-8 sm:grid-cols-2"
            {...revealGroup}
          >
            {previous !== null ? (
              <SiteLink
                href={previous.href}
                className="focus-ring rounded-xl border border-hairline bg-surface p-4 transition-colors hover:border-hairline-strong hover:bg-raised"
                {...reveal}
              >
                <span className="font-mono text-2xs uppercase tracking-widest text-muted">
                  {t("article.previous")}
                </span>
                <span className="mt-1 block font-sans text-sm font-medium text-heading">
                  {t(`pages.${previous.id}.title`)}
                </span>
              </SiteLink>
            ) : (
              <span />
            )}
            {next !== null && (
              <SiteLink
                href={next.href}
                className="focus-ring rounded-xl border border-hairline bg-surface p-4 text-right transition-colors hover:border-hairline-strong hover:bg-raised sm:col-start-2"
                {...reveal}
              >
                <span className="font-mono text-2xs uppercase tracking-widest text-muted">
                  {t("article.next")}
                </span>
                <span className="mt-1 block font-sans text-sm font-medium text-heading">
                  {t(`pages.${next.id}.title`)}
                </span>
              </SiteLink>
            )}
          </nav>
        )}
      </article>

      <aside className="hidden w-52 flex-none xl:block">
        <nav aria-label={t("article.onThisPage")} className="sticky top-20 pb-10">
          <p className="mb-3 font-mono text-2xs uppercase tracking-widest text-muted">
            {t("article.onThisPage")}
          </p>
          <ul className="space-y-2 border-l border-hairline">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="focus-ring -ml-px block border-l border-transparent pl-3 font-sans text-sm leading-6 text-body transition-colors hover:border-accent-solid hover:text-heading"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
    </div>
  );
}
