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
  /* One constant per deploy for the service worker registration URL. The
     previous key was hashed from the page's script tags, which change as
     Next prefetches routes, so every load looked like a new worker and the
     controller change handler reloaded the page without end. */
  env: {
    NEXT_PUBLIC_BUILD_KEY: process.env.VERCEL_DEPLOYMENT_ID ??
      process.env.VERCEL_GIT_COMMIT_SHA ?? String(Date.now()),
  },
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
    /* Re-enabled 2026-09-07: the crash recorded against this flag on
       2026-08-11 no longer reproduces. `next build` now completes and `/app`
       prerenders as static content with this on (verified: 108/108 pages
       generated, `/app` server bundle 302,015 bytes unminified versus 72,575
       minified, a 76% cut). The terser interaction the follow-up named was
       either fixed by an unrelated later change or was masked the whole time
       by a separate, unrelated build failure (a page component's test only
       props tripping Next's own route type check, fixed alongside this in
       the same pass: see app/app/cli/cli-page-view.tsx). If `next build`
       ever crashes again on this flag specifically, isolate the failing
       module with `serverExternalPackages` or a dynamic import before
       reaching for this switch again. */
    serverMinification: true,
  },

  /**
   * The pairing code lives in the URL fragment, which no request header
   * carries anyway, but the pair route says so as a real HTTP header rather
   * than trusting the page's own `metadata.referrer` alone: a `<meta>` tag is
   * something every embedder and crawler has to choose to honour, and a header
   * is the one guarantee that applies before any of that policy is even read.
   */
  async headers() {
    return [
      {
        source: "/app/pair",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        source: "/app/pair/api/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
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
