import Link from "next/link";
import type { ReactNode } from "react";
import { JsonLd } from "@/components/json-ld";
import { docNeighbours } from "@/lib/docs";
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
 * beside the trail a reader can see, and both are built from the `href` this
 * component already receives. A page cannot show one trail and declare another.
 */
export function DocArticle({
  href,
  title,
  lead,
  sections,
}: {
  href: string;
  title: string;
  lead: string;
  sections: readonly DocSection[];
}) {
  const { previous, next } = docNeighbours(href);

  return (
    <div className="flex gap-12">
      <article className="min-w-0 max-w-3xl flex-1 pb-20">
        <JsonLd data={docsBreadcrumbSchema(href)} />
        {/* The page header arrives as one group: trail, title, lead, 70ms
            apart. The wrapper carries no styling of its own, so the rhythm the
            margins below set is untouched. */}
        <div {...revealGroup}>
          <nav aria-label="Breadcrumb" {...revealSm}>
            <ol className="flex items-center gap-2 font-mono text-2xs uppercase tracking-widest text-muted">
              <li>
                <Link
                  href="/docs"
                  className="focus-ring rounded transition-colors hover:text-heading"
                >
                  Docs
                </Link>
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
            aria-label="Documentation pages"
            className="mt-16 grid grid-cols-1 gap-4 border-t border-hairline pt-8 sm:grid-cols-2"
            {...revealGroup}
          >
            {previous !== null ? (
              <Link
                href={previous.href}
                className="focus-ring rounded-xl border border-hairline bg-surface p-4 transition-colors hover:border-hairline-strong hover:bg-raised"
                {...reveal}
              >
                <span className="font-mono text-2xs uppercase tracking-widest text-muted">
                  Previous
                </span>
                <span className="mt-1 block font-sans text-sm font-medium text-heading">
                  {previous.title}
                </span>
              </Link>
            ) : (
              <span />
            )}
            {next !== null && (
              <Link
                href={next.href}
                className="focus-ring rounded-xl border border-hairline bg-surface p-4 text-right transition-colors hover:border-hairline-strong hover:bg-raised sm:col-start-2"
                {...reveal}
              >
                <span className="font-mono text-2xs uppercase tracking-widest text-muted">Next</span>
                <span className="mt-1 block font-sans text-sm font-medium text-heading">
                  {next.title}
                </span>
              </Link>
            )}
          </nav>
        )}
      </article>

      <aside className="hidden w-52 flex-none xl:block">
        <nav aria-label="On this page" className="sticky top-20 pb-10">
          <p className="mb-3 font-mono text-2xs uppercase tracking-widest text-muted">
            On this page
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
