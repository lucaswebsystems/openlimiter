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
  },

  /**
   * The social card reads the wordmark font off disk at render time, from
   * assets/fonts. Next works out which files a route needs by reading the code,
   * and it does understand a path built from process.cwd(), but a font that
   * fails to come along is a card route that returns 500 in production and
   * nowhere else. Saying so outright costs one line and removes the guess.
   */
  outputFileTracingIncludes: {
    "/opengraph-image": ["./assets/fonts/**"],
    "/twitter-image": ["./assets/fonts/**"],
  },
};

export default withNextIntl(nextConfig);
