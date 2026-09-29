import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/json-ld";
import { PageShell } from "@/components/page-shell";
import { findPost, formatPostDate, posts, type Block } from "@/lib/blog";
import { AUTHOR_LINKEDIN, AUTHOR_NAME, AUTHOR_SITE } from "@/lib/site";
import { blogBreadcrumbSchema, blogPostingSchema } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/metadata";

/**
 * /blog/[slug]
 *
 * One post, rendered from the typed Block union in lib/blog.ts. Blocks are data
 * rather than markdown, so the switch below is the entire renderer and the
 * compiler fails the build if a new kind of block is ever added without a case
 * here. Nothing can be silently swallowed on the way to the page.
 *
 * Next 15 hands `params` to a page as a promise, so both the page and the
 * metadata function await it before reading the slug.
 *
 * The title tag is set absolute rather than through the root template, because
 * this post's own title already opens with the product name and the template
 * would append it a second time. The social card is told the same thing, so it
 * carries the post's title rather than the home page's.
 *
 * The BlogPosting block is built from the same post record the page renders, so
 * a headline or a date can only be wrong in lib/blog.ts.
 */

/* Finite slugs, so an unknown one is rejected before the route matches and the
   request reaches global-not-found's real page instead of the markupless shell
   a request time notFound() renders. The comparison pages that shared this pattern are gone by order. */
export const dynamicParams = false;

export async function generateStaticParams() {
  return posts.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = findPost(slug);
  if (post === undefined) return { title: "Post not found" };

  return pageMetadata({
    title: post.title,
    description: post.description,
    route: `/blog/${slug}`,
    /* A post is written once, in English, and is not translated. It carries a
       canonical and no hreflang map. See lib/metadata.ts. */
    locale: "en",
    localised: false,
    absoluteTitle: true,
    published: post.date,
  });
}

/** The whole formatting vocabulary a post is allowed to use. */
function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "p":
      return <p className="text-base leading-relaxed text-soft">{block.text}</p>;

    case "h2":
      return (
        <h2 id={block.id} className="scroll-mt-8 text-xl font-medium text-heading">
          {block.text}
        </h2>
      );

    case "list":
      return (
        <ul className="list-outside list-disc space-y-2 pl-5">
          {block.items.map((item, index) => (
            <li key={index} className="text-base leading-relaxed text-muted">
              {item}
            </li>
          ))}
        </ul>
      );

    case "code":
      return (
        <figure>
          <figcaption className="font-mono text-2xs uppercase tracking-widest text-muted">
            {block.caption}
          </figcaption>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-hairline bg-code p-4 font-mono text-2xs leading-6 text-soft">
            <code>{block.text}</code>
          </pre>
        </figure>
      );

    case "quote":
      return (
        <blockquote className="border-l-2 border-hairline-strong pl-4 italic text-soft">
          {block.text}
        </blockquote>
      );
  }
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = findPost(slug);
  if (post === undefined) notFound();

  return (
    <PageShell title={post.title} lead={post.description}>
      <JsonLd data={blogPostingSchema(post)} />
      <JsonLd data={blogBreadcrumbSchema(post)} />
      {/* 576 pixels, which is the reading column the whole post sits in. */}
      <article className="max-w-xl">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="focus-ring rounded text-accent hover:text-heading">Home</Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href="/blog" className="focus-ring rounded text-accent hover:text-heading">Blog</Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="truncate">{post.title}</li>
          </ol>
        </nav>
        <time dateTime={post.date} className="block text-sm text-muted">
          {formatPostDate(post.date)}
        </time>
        <p className="mt-3 text-sm text-muted">
          By <Link href={AUTHOR_SITE} className="focus-ring rounded text-accent hover:text-heading">{AUTHOR_NAME}</Link>, author and maintainer. <Link href={AUTHOR_LINKEDIN} className="focus-ring rounded text-accent hover:text-heading">Profile</Link>
        </p>

        <div className="mt-10 space-y-6">
          {post.body.map((block, index) => (
            <BlockView key={index} block={block} />
          ))}
        </div>

        <div className="mt-12 border-t border-hairline pt-6">
          <Link
            href="/blog"
            className="focus-ring rounded text-sm text-accent transition-colors hover:text-heading"
          >
            Back to the blog
          </Link>
        </div>
      </article>
    </PageShell>
  );
}
