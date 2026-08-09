import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Outfit } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  weight: ["400", "600", "800"],
  display: "swap",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  weight: ["400", "500"],
  display: "swap",
});

const title = "OpenLimiter, quota awareness for AI coding agents";
const description =
  "OpenLimiter gives AI coding agents bounded quota context and routing advice across your subscriptions.";

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
    <html lang="en" className={`${outfit.variable} ${jetBrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
