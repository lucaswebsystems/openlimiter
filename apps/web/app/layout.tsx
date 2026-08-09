import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Footer } from "@/components/footer";
import { Nav } from "@/components/nav";
import { RevealController } from "@/components/reveal-controller";
import { revealArmScript } from "@/lib/reveal";
import { themeArmScript } from "@/lib/theme";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  weight: ["400", "500", "600"],
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  weight: ["400", "500"],
  display: "swap",
});

const title = "OpenLimiter, quota awareness for AI coding agents";
const description =
  "OpenLimiter reads the quota of your AI subscriptions on your own machine and hands your coding agents bounded budget state plus routing advice. Open source, local first, zero telemetry.";

export const metadata: Metadata = {
  metadataBase: new URL("https://openlimiter.com"),
  title: {
    default: title,
    template: "%s, OpenLimiter",
  },
  description,
  applicationName: "OpenLimiter",
  alternates: {
    canonical: "/",
  },
  authors: [
    {
      name: "Lucas Costa",
      url: "https://lucaswebsystems.com",
    },
  ],
  creator: "Lucas Costa",
  publisher: "OpenLimiter",
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
    siteName: "OpenLimiter",
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
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Applies a stored theme choice before first paint. See lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: themeArmScript }} />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-body antialiased selection:bg-accent-subtle selection:text-heading">
        {/* Arms the scroll reveal before first paint. See lib/reveal.ts. */}
        <script dangerouslySetInnerHTML={{ __html: revealArmScript }} />
        <a
          href="#main"
          className="focus-ring sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-hairline focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-heading"
        >
          Skip to content
        </a>
        <Nav />
        {children}
        <Footer />
        <RevealController />
      </body>
    </html>
  );
}
