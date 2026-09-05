import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

/**
 * Points next-intl at the request configuration, which is what makes the
 * message catalog available to a Server Component without every page having to
 * load it by hand. See i18n/request.ts.
 */
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  /* The tracing root exists for the LOCAL monorepo, where sibling lockfiles
     make Next guess the workspace root. On Vercel the app IS the root, and
     pointing tracing above it doubles the output path (/vercel/path0 twice)
     and kills the build, so the setting stays local only. */
  ...(process.env.VERCEL
    ? {}
    : { outputFileTracingRoot: path.resolve(__dirname, "../../") }),

  /**
   * Several agent lanes run Next against this app at the same time, and two
   * processes sharing one .next corrupt each other's chunks mid compile. A
   * lane that sets OL_DIST_DIR gets its own build directory; every process
   * that does not set it, local dev and the real deploy included, keeps the
   * default and nothing changes for them.
   */
  distDir: process.env.OL_DIST_DIR ?? ".next",

  /**
   * Lets app/global-not-found.tsx own the 404 for a request that matched no
   * route.
   *
   * It is on because this app has no `app/layout.tsx`: `html lang` has to be
   * right per locale, so the localised tree owns a root layout and every other
   * top level tree owns its own. Next then has no single document to render a
   * request time 404 in and serves an internal shell with no markup in it, which
   * is the right status code over a blank page. This flag is the mechanism Next
   * provides for that case.
   */
  experimental: {
    globalNotFound: true,
    /* The /app prerender crashes only when the server bundle is minified, a
       terser interaction inside the mirrored engine that dev, tests, and the
       unminified build all pass. Server minification stays off until the root
       cause is found (follow-up recorded 2026-08-11); the cost is bundle size
       on the server only, never a user facing byte. */
    serverMinification: false,
  },

  /**
   * The comparison pages are gone by the founder's order (2026-08-10). Links
   * and search results that still carry the old URLs, in any locale, land on
   * the matching home page with a permanent redirect rather than on a 404.
   * These run before the middleware, so no locale rewrite sees them.
   */
  async redirects() {
    return [
      /* Stripe returns a finished checkout to /app/billing, which is the
         address the hosted functions were built with and is not a page here.
         The portal is where every billing state is drawn, so the return lands
         there instead, carrying its own `checkout` parameter with it: Next
         forwards a query string whenever the destination declares none. */
      { source: "/app/billing", destination: "/pro", permanent: false },
      { source: "/alternatives", destination: "/", permanent: true },
      { source: "/alternatives/:slug*", destination: "/", permanent: true },
      {
        source: "/:locale(pt-BR|es|de|ja)/alternatives/:slug*",
        destination: "/:locale",
        permanent: true,
      },
      {
        source: "/:locale(pt-BR|es|de|ja)/alternatives",
        destination: "/:locale",
        permanent: true,
      },
    ];
  },

};

export default withNextIntl(nextConfig);
