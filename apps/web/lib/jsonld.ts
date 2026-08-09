import type { FaqItem } from "@/components/faq";
import type { Post } from "./blog";
import { findDocPage } from "./docs";
import {
  AUTHOR_NAME,
  AUTHOR_SITE,
  CURRENT_VERSION,
  LICENSE_SPDX_URL,
  LOGO_SIZE,
  LOGO_URL,
  RELEASES_URL,
  REPO_URL,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "./site";

/**
 * Structured data, built in one place.
 *
 * Every builder here reads the same constants the pages read, so a version, a
 * URL or a licence can only be wrong in one file rather than in five. Nothing
 * in this module invents a fact: there is no rating, no review count and no
 * user number anywhere, because none of those exist to be counted.
 *
 * The blocks are rendered by the JsonLd component, which is a server component
 * and emits a plain script tag. No structured data is produced in a browser.
 */

export type JsonLdNode = Record<string, unknown>;

const SCHEMA = "https://schema.org";

/**
 * Stable node identifiers. One block can point at another with `@id` instead of
 * describing the same organisation three times on one page.
 */
export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const SOFTWARE_ID = `${SITE_URL}/#software`;

/**
 * The organisation as an embeddable node, without the context line.
 *
 * A page that only names the publisher in passing, such as a blog post, embeds
 * this whole node rather than referencing an `@id` that page never defines.
 */
function organizationNode(): JsonLdNode {
  return {
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: SITE_NAME,
    url: SITE_URL,
    logo: {
      "@type": "ImageObject",
      url: LOGO_URL,
      width: LOGO_SIZE,
      height: LOGO_SIZE,
    },
    sameAs: [REPO_URL],
  };
}

/** The author of the software and of every post on the site. */
function authorNode(): JsonLdNode {
  return {
    "@type": "Person",
    name: AUTHOR_NAME,
    url: AUTHOR_SITE,
  };
}

export function organizationSchema(): JsonLdNode {
  return { "@context": SCHEMA, ...organizationNode() };
}

export function websiteSchema(): JsonLdNode {
  return {
    "@context": SCHEMA,
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    inLanguage: "en",
    publisher: { "@id": ORGANIZATION_ID },
  };
}

/**
 * The product itself.
 *
 * The price is zero and the offer says so explicitly, because a reader and a
 * crawler both ask that question first. The licence points at the canonical
 * Apache 2.0 text rather than at a copy, and the download URL points at the
 * releases page, which is where every packaged build actually is.
 */
export function softwareApplicationSchema(): JsonLdNode {
  return {
    "@context": SCHEMA,
    "@type": "SoftwareApplication",
    "@id": SOFTWARE_ID,
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Windows, macOS, Linux",
    softwareVersion: CURRENT_VERSION,
    downloadUrl: RELEASES_URL,
    license: LICENSE_SPDX_URL,
    isAccessibleForFree: true,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
    },
    softwareHelp: {
      "@type": "WebPage",
      url: `${SITE_URL}/docs`,
    },
    author: authorNode(),
    publisher: { "@id": ORGANIZATION_ID },
    sameAs: [REPO_URL],
  };
}

/**
 * The home page questions, from the same array the page renders.
 *
 * The argument is the rendered list rather than an import of it, so this
 * function cannot be handed a different set of answers than the ones on screen
 * without the caller doing it deliberately.
 */
export function faqPageSchema(items: readonly FaqItem[]): JsonLdNode {
  return {
    "@context": SCHEMA,
    "@type": "FAQPage",
    "@id": `${SITE_URL}/#faq`,
    inLanguage: "en",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.answer,
      },
    })),
  };
}

/** One post, from the typed post data rather than from the rendered markup. */
export function blogPostingSchema(post: Post): JsonLdNode {
  const url = `${SITE_URL}/blog/${post.slug}`;

  return {
    "@context": SCHEMA,
    "@type": "BlogPosting",
    "@id": `${url}#post`,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    url,
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.date,
    inLanguage: "en",
    author: authorNode(),
    publisher: organizationNode(),
  };
}

/**
 * The trail above a documentation page, from the same list that draws the
 * sidebar. A page missing from lib/docs.ts gets the two step trail rather than
 * a fabricated third step.
 */
export function docsBreadcrumbSchema(href: string): JsonLdNode {
  const page = findDocPage(href);

  const trail: { name: string; url: string }[] = [
    { name: "Home", url: SITE_URL },
    { name: "Docs", url: `${SITE_URL}/docs` },
  ];

  if (page !== undefined && page.href !== "/docs") {
    trail.push({ name: page.title, url: `${SITE_URL}${page.href}` });
  }

  return {
    "@context": SCHEMA,
    "@type": "BreadcrumbList",
    itemListElement: trail.map((step, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: step.name,
      item: step.url,
    })),
  };
}
