import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SITE_NAME, SITE_URL } from "@/lib/site";

/**
 * The baseline above the three documents, and nothing more.
 *
 * WHY IT RETURNS ITS CHILDREN UNCHANGED
 * -------------------------------------
 * This site renders three separate documents, because `html lang` has to state
 * the truth about the page: the localised marketing tree renders one per
 * locale, the web application renders an English one with its own manifest and
 * viewport, and the blog renders a third. Each of those layouts owns its own
 * `<html>` and `<body>`, through components/site-html.tsx, and that
 * arrangement is deliberate rather than incidental.
 *
 * So this file adds no element at all. It exists for one reason: a layout at
 * the top of `app/` is where the metadata baseline belongs, and where every
 * tool that reads a Next application looks for it. Returning `children`
 * verbatim leaves each tree's document exactly as it was, which is checked
 * rather than assumed: the built pages carry one `<html>`, one `<body>` and
 * the right `lang` in every locale.
 *
 * WHAT THE BASELINE DELIBERATELY OMITS
 * ------------------------------------
 * No `alternates`. A canonical declared here would be inherited by any page
 * that declares none, and a page silently canonicalising itself to the home
 * page is a worse failure than having no baseline at all. Every content page
 * builds its own canonical and its own `hreflang` map through lib/metadata.ts,
 * which is the one place that decision is made.
 *
 * No `robots` either. The default is indexable, the pages that must not be
 * indexed say so themselves, and a baseline that could be forgotten in the
 * wrong direction is not worth the line.
 *
 * And no title template. Each of the three documents already declares one, and
 * a template here would be applied to their defaults as well, appending the
 * product name to a title that already ends in it. The rendered head of every
 * page is byte for byte what it was before this file existed, which is how the
 * change was checked.
 */

const title = "OpenLimiter, a local first quota meter for AI coding subscriptions";
const description =
  "Read the quota of your AI coding subscriptions from what your own machine already knows, keep every number bounded, and hand your coding agent a budget block it can act on.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title,
    description,
    images: [{ url: "/opengraph-image", width: 1200, height: 630, alt: SITE_NAME }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [{ url: "/twitter-image", alt: SITE_NAME }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
