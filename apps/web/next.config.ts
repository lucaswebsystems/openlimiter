import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, "../../"),

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
};

export default nextConfig;
