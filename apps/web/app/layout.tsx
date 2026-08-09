import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { RevealController } from "@/components/reveal-controller";
import { revealArmScript } from "@/lib/reveal";
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
  "OpenLimiter reads your supported AI subscriptions and tells your coding agents which one still has budget, right inside their own context. Open source, local first, cross platform.";

export const metadata: Metadata = {
  metadataBase: new URL("https://openlimiter.com"),
  title,
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
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} bg-canvas text-body antialiased`}>
      <body className="min-h-screen bg-canvas font-sans text-body selection:bg-accent/20 selection:text-heading">
        {/* Arms the scroll reveal before first paint. See lib/reveal.ts. */}
        <script dangerouslySetInnerHTML={{ __html: revealArmScript }} />
        {children}
        <RevealController />
      </body>
    </html>
  );
}

