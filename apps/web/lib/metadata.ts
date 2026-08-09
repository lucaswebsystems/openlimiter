import type { Metadata } from "next";
import { findDocPage } from "./docs";
import { AUTHOR_NAME, SITE_NAME, TITLE_SUFFIX } from "./site";

/**
 * Per page metadata, built once.
 *
 * Next inherits the root `openGraph` block wholesale when a page does not set
 * one, which is how every subpage on this site ended up sharing the home page's
 * social title and description. A page that goes through this helper cannot do
 * that: its card always carries its own title, its own description and its own
 * URL.
 *
 * The social title is the page title plus the suffix the title template
 * appends, so the card and the tag in the head say exactly the same words. The
 * suffix is read from lib/site.ts rather than typed here, because a template
 * that changes in one of those two places and not the other is the whole
 * failure this helper exists to avoid.
 */

const LOCALE = "en_US";

export interface PageMetadataInput {
  /** The page's own title, before the template appends the site name. */
  title: string;
  description: string;
  /** Route, always absolute. Used for the canonical and for the card URL. */
  path: string;
  /**
   * Set when the title tag bypasses the template, which a blog post does
   * because its own title already opens with the product name.
   */
  absoluteTitle?: boolean;
  /** Present on a post, which makes the card an article rather than a page. */
  published?: string;
}

export function pageMetadata(input: PageMetadataInput): Metadata {
  const { title, description, path, absoluteTitle = false, published } = input;

  const social = absoluteTitle ? title : `${title}${TITLE_SUFFIX}`;

  const shared = {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    twitter: {
      card: "summary_large_image" as const,
      title: social,
      description,
    },
  };

  if (published !== undefined) {
    return {
      ...shared,
      openGraph: {
        type: "article",
        url: path,
        siteName: SITE_NAME,
        title: social,
        description,
        locale: LOCALE,
        publishedTime: published,
        authors: [AUTHOR_NAME],
      },
    };
  }

  return {
    ...shared,
    openGraph: {
      type: "website",
      url: path,
      siteName: SITE_NAME,
      title: social,
      description,
      locale: LOCALE,
    },
  };
}

/**
 * A documentation page's metadata, from the same list that draws the sidebar.
 *
 * A doc page may carry a longer `metaTitle` than the label in the sidebar, so a
 * search result can describe the page while the navigation stays short. When it
 * has none, the sidebar label is the title, which is what every page did before
 * this existed.
 */
export function docMetadata(href: string): Metadata {
  const page = findDocPage(href);

  if (page === undefined) {
    return { alternates: { canonical: href } };
  }

  return pageMetadata({
    title: page.metaTitle ?? page.title,
    description: page.description,
    path: href,
  });
}
