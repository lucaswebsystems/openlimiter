import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { Card } from "@/components/ui";
import { COMPARISON_NOTE, alternatives } from "@/lib/alternatives";

/**
 * /alternatives
 *
 * The index of the comparison pages. Every entry comes from lib/alternatives.ts,
 * where the rule is that each tool's genuine strength is written before any
 * difference is described, and where several of these tools are more mature
 * than this one.
 *
 * The note about when and how these were checked sits above the grid rather
 * than under it, because a reader deciding whether to trust a comparison needs
 * that before they read the comparison, not after.
 */

export const metadata: Metadata = {
  title: "Alternatives",
  description:
    "Honest comparisons between OpenLimiter and the other tools that read AI subscription quota, each one read off its own repository or store listing.",
  alternates: { canonical: "/alternatives" },
};

export default function AlternativesPage() {
  return (
    <PageShell
      title="Alternatives"
      lead="Other tools solve a problem that overlaps this one. Each page below says what that tool does well before it says where OpenLimiter differs, and the difference described is scope rather than quality."
    >
      <Card className="max-w-xl">
        <p className="font-mono text-2xs uppercase tracking-widest text-muted">
          How these were checked
        </p>
        <p className="mt-2 text-sm leading-relaxed text-body">{COMPARISON_NOTE}</p>
      </Card>

      <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {alternatives.map((entry) => (
          <Link
            key={entry.slug}
            href={`/alternatives/${entry.slug}`}
            className="focus-ring flex h-full flex-col rounded-xl border border-hairline bg-surface p-6 transition-colors hover:bg-raised"
          >
            <h2 className="text-xl font-medium text-heading">{entry.name}</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">{entry.summary}</p>
            <p className="mt-auto pt-4 text-xs text-muted">Read the comparison</p>
          </Link>
        ))}
      </div>
    </PageShell>
  );
}
