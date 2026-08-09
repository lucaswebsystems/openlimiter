import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { RegisterServiceWorker } from "./register-service-worker";

/**
 * The application shell.
 *
 * Everything a home screen installation needs is declared here rather than in
 * the root layout, so the manifest, the standalone display and the service
 * worker belong to this route alone. A visitor reading the documentation never
 * meets any of it.
 */

const title = "Quota dashboard";
const description =
  "Read your AI subscription quota in the browser, with the same engine the command line tool uses. Everything stays on your device: nothing is uploaded, there is no account, and there is no analytics.";

export const metadata: Metadata = {
  title,
  description,
  applicationName: "OpenLimiter",
  alternates: { canonical: "/app" },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "OpenLimiter",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    type: "website",
    url: "/app",
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
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
  ],
};

export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <RegisterServiceWorker />
      {children}
    </>
  );
}
