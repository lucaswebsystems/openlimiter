import type { Metadata } from "next";
import Link from "next/link";
import { PageShell } from "@/components/page-shell";
import { formatPostDate, posts } from "@/lib/blog";

/**
 * /blog
 *
 * The index. There is one post today and the lead says so, because a blog index
 * that pads itself out with placeholders is the first thing on a site that
 * stops being true. The count is read from the data rather than typed here, so
 * the sentence cannot go stale the moment a second post lands.
 */

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Notes on how OpenLimiter reads quota locally, what it deliberately does not do, and why the line is drawn where it is.",
  alternates: { canonical: "/blog" },
};

const countLine =
  posts.length === 1 ? "There is one post so far." : `There are ${posts.length} posts so far.`;

const linkClass = "focus-ring rounded text-accent transition-colors hover:text-heading";

export default function BlogIndexPage() {
  return (
    <PageShell
      title="Blog"
      lead={`Occasional writing about what OpenLimiter does, what it refuses to do, and why. ${countLine}`}
    >
      <div className="space-y-4">
        {posts.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="focus-ring block max-w-xl rounded-xl border border-hairline bg-surface p-6 transition-colors hover:bg-raised"
          >
            <h2 className="text-xl font-medium text-heading">{post.title}</h2>
            <time dateTime={post.date} className="mt-2 block text-sm text-muted">
              {formatPostDate(post.date)}
            </time>
            <p className="mt-3 text-sm leading-relaxed text-muted">{post.description}</p>
          </Link>
        ))}
      </div>

      <p className="mt-16 max-w-xl text-sm leading-relaxed text-muted">
        Released changes are listed on the{" "}
        <Link href="/changelog" className={linkClass}>
          changelog
        </Link>{" "}
        instead, and the reasoning behind the design lives in the{" "}
        <Link href="/docs" className={linkClass}>
          documentation
        </Link>
        .
      </p>
    </PageShell>
  );
}
