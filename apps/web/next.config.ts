import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,

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
