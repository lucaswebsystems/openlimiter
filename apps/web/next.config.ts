import path from "node:path";
import type { NextConfig } from "next";

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

  /**
   * The comparison pages are gone by the founder's order (2026-08-10). Links
   * and search results that still carry the old URLs land on the home page
   * with a permanent redirect rather than on a 404.
   */
  async redirects() {
    return [
      { source: "/alternatives", destination: "/", permanent: true },
      { source: "/alternatives/:slug*", destination: "/", permanent: true },
    ];
  },
};

export default nextConfig;
