import { Analytics } from "@vercel/analytics/react";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AnnouncementBar } from "@/components/announcement-bar";
import { Footer } from "@/components/footer";
import { Nav } from "@/components/nav";
import { Reveal } from "@/components/reveal";
import { announceArmScript } from "@/lib/announce";
import { markArmScript } from "@/lib/brand";
import { wordmarkFont } from "@/lib/fonts";
import { motionArmScript } from "@/lib/motion";
import {
  AUTHOR_NAME,
  AUTHOR_SITE,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE,
  SITE_URL,
  TITLE_SUFFIX,
} from "@/lib/site";
import { themeArmScript } from "@/lib/theme";
import "./globals.css";

const title = SITE_TITLE;
const description = SITE_DESCRIPTION;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: title,
    template: `%s${TITLE_SUFFIX}`,
  },
  description,
  applicationName: SITE_NAME,
  alternates: {
    canonical: "/",
  },
  authors: [
    {
      name: AUTHOR_NAME,
      url: AUTHOR_SITE,
    },
  ],
  creator: AUTHOR_NAME,
  publisher: SITE_NAME,
  keywords: [
    "AI coding agents",
    "quota awareness",
    "Claude Code",
    "Codex CLI",
    "OpenCode",
    "open source",
    "local first",
  ],
  openGraph: {
    type: "website",
    url: "/",
    siteName: SITE_NAME,
    title,
    description,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    /* The display face is published as a custom property on the root element,
       which is what lets app/globals.css set every heading in it without a
       class on each one, and what lets the dashboard's own stylesheet reach
       the same loaded file. See lib/fonts.ts: it is loaded once. */
    <html lang="en" className={wordmarkFont.variable} suppressHydrationWarning>
      <head>
        {/* Applies a stored theme choice before first paint. See lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: themeArmScript }} />
        {/* Decides whether the mark draws itself in on this load. See lib/brand.ts. */}
        <script dangerouslySetInnerHTML={{ __html: markArmScript }} />
        {/* Arms the scroll reveal, but only where it is safe. See lib/motion.ts. */}
        <script dangerouslySetInnerHTML={{ __html: motionArmScript }} />
        {/* Closes the announcement bar before it paints, for a reader who has
            already closed it once. See lib/announce.ts. */}
        <script dangerouslySetInnerHTML={{ __html: announceArmScript }} />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-body antialiased selection:bg-accent-subtle selection:text-heading">
        <a
          href="#main"
          className="focus-ring sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:border focus:border-hairline focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-heading"
        >
          Skip to content
        </a>
        <AnnouncementBar />
        <Nav />
        {children}
        <Footer />
        {/* The one client component the motion system has. See lib/motion.ts. */}
        <Reveal />
        {/* Cookieless, first party page counting. No cookies, no cross site
            tracking, no personal identifiers: the open source card's telemetry
            claim stays about the product, and the footer discloses this. */}
        <Analytics />
      </body>
    </html>
  );
}
