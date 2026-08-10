import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { RegisterServiceWorker } from "./register-service-worker";
import { imagePalette } from "@/lib/image-palette";
/* The pressure scale and the segmented meter, which only this route uses. */
import "./theme.css";

/**
 * The application shell.
 *
 * Everything a home screen installation needs is declared here rather than in
 * the root layout, so the manifest, the standalone display and the service
 * worker belong to this route alone. A visitor reading the documentation never
 * meets any of it.
 *
 * The three pieces that decide what an installed copy looks like before any of
 * this route's own code runs:
 *
 *   `manifest` points at public/manifest.webmanifest, which declares the
 *   standalone display and the background colour the platform paints during
 *   launch. That colour is the dark canvas, so the first frame of a launch is
 *   already the product rather than a white sheet.
 *
 *   `appleWebApp` is what iOS reads instead. Capable gives it the standalone
 *   window; the translucent status bar lets the canvas run under the clock,
 *   which is what makes it look like an application rather than a page. The
 *   home screen icon itself comes from app/apple-icon.tsx, which Next links on
 *   every route.
 *
 *   `viewportFit: cover` is what makes `env(safe-area-inset-*)` report real
 *   numbers, and theme.css spends them on the shell so nothing lands under a
 *   notch or a home indicator.
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
  /*
    The older Safari spelling, added by hand.

    `appleWebApp.capable` above emits the modern `mobile-web-app-capable`, which
    is what Chrome and current Safari read. Versions of iOS still in use only
    know the apple prefixed name, and a home screen launch that misses it opens
    inside the browser chrome instead of as an application, which is the one
    thing this whole route is arranged around. Both names, no guessing.
  */
  other: { "apple-mobile-web-app-capable": "yes" },
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
  /*
    The installed window's own chrome, which cannot read a CSS variable, so it
    reads the same literal the icon routes do. See lib/image-palette.ts.

    One value, not one per scheme, and that is deliberate. This product is dark
    first: globals.css paints the dark palette for every visitor whatever their
    system preference says, and light is reached only by asking for it through
    the toggle. Handing the platform a light bar for a system preference the
    page itself ignores is how an installed copy ends up with a white strip
    above a near black canvas.
  */
  themeColor: imagePalette.canvas,
};

export default function AppLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <>
      <RegisterServiceWorker />
      {children}
    </>
  );
}
