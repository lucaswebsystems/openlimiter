import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageShell, ShellSections } from "@/components/page-shell";
import { ButtonLink, Card, SectionHeading } from "@/components/ui";
import { COMPARISON_NOTE, alternatives, findAlternative } from "@/lib/alternatives";

/**
 * /alternatives/[slug]
 *
 * One comparison, in a fixed order that the data enforces: what the tool is,
 * what it does, what it does better than OpenLimiter, and only then where the
 * two differ. The link out to the project's own page sits near the top, next to
 * the facts, so a reader can go and check any of this before reading further.
 *
 * Next 15 hands `params` to a page as a promise, so both the page and the
 * metadata function await it before reading the slug.
 */

export async function generateStaticParams() {
  return alternatives.map((entry) => ({ slug: entry.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entry = findAlternative(slug);
  if (entry === undefined) return { title: "Comparison not found" };

  return {
    title: `${entry.name} compared`,
    description: entry.summary,
    alternates: { canonical: `/alternatives/${slug}` },
  };
}

export default async function AlternativePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entry = findAlternative(slug);
  if (entry === undefined) notFound();

  const index = alternatives.indexOf(entry);
  const previous = index > 0 ? alternatives[index - 1] : undefined;
  const next = index < alternatives.length - 1 ? alternatives[index + 1] : undefined;

  const facts = [
    { term: "Platform", detail: entry.platform },
    { term: "Licence", detail: entry.licence },
    { term: "Coverage", detail: entry.coverage },
    { term: "Source", detail: entry.source },
  ];

  return (
    <PageShell title={`${entry.name} and OpenLimiter`} lead={entry.summary}>
      <dl className="grid max-w-3xl grid-cols-1 gap-6 rounded-xl border border-hairline bg-surface p-6 sm:grid-cols-2">
        {facts.map((fact) => (
          <div key={fact.term}>
            <dt className="text-xs uppercase tracking-widest text-muted">{fact.term}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-body">{fact.detail}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-6">
        <ButtonLink href={entry.url} external>
          Visit {entry.name}
        </ButtonLink>
      </div>

      <div className="mt-24">
        <ShellSections>
          <section>
            <SectionHeading id="what-it-does" title="What it does" />
            <p className="max-w-xl text-base leading-relaxed text-soft">{entry.what}</p>
          </section>

          <section>
            <SectionHeading id="strength" title="What it does well" />
            <p className="max-w-xl text-base leading-relaxed text-soft">{entry.strength}</p>
          </section>

          <section>
            <SectionHeading id="difference" title="Where OpenLimiter differs" />
            <p className="max-w-xl text-base leading-relaxed text-soft">{entry.difference}</p>
          </section>

          <div className="max-w-xl space-y-4">
            {entry.caveat !== undefined && (
              <Card>
                <p className="font-mono text-2xs uppercase tracking-widest text-muted">
                  Before you go looking
                </p>
                <p className="mt-2 text-sm leading-relaxed text-body">{entry.caveat}</p>
              </Card>
            )}

            <Card>
              <p className="font-mono text-2xs uppercase tracking-widest text-muted">
                How these were checked
              </p>
              <p className="mt-2 text-sm leading-relaxed text-body">{COMPARISON_NOTE}</p>
            </Card>
          </div>
        </ShellSections>
      </div>

      <nav
        aria-label="Other comparisons"
        className="mt-16 flex flex-wrap items-start justify-between gap-6 border-t border-hairline pt-6"
      >
        {previous !== undefined ? (
          <Link href={`/alternatives/${previous.slug}`} className="focus-ring rounded">
            <span className="block text-xs uppercase tracking-widest text-muted">Previous</span>
            <span className="mt-1 block text-sm text-accent">{previous.name}</span>
          </Link>
        ) : (
          <Link href="/alternatives" className="focus-ring rounded">
            <span className="block text-xs uppercase tracking-widest text-muted">Back</span>
            <span className="mt-1 block text-sm text-accent">All comparisons</span>
          </Link>
        )}

        {next !== undefined && (
          <Link
            href={`/alternatives/${next.slug}`}
            className="focus-ring ml-auto rounded text-right"
          >
            <span className="block text-xs uppercase tracking-widest text-muted">Next</span>
            <span className="mt-1 block text-sm text-accent">{next.name}</span>
          </Link>
        )}
      </nav>
    </PageShell>
  );
}
