import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  esbuild: false,
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@openlimiter/core": fileURLToPath(
        new URL("./.test-dist/packages/core/src/index.js", import.meta.url)
      ),
      "@openlimiter/connectors": fileURLToPath(
        new URL("./.test-dist/packages/connectors/src/index.js", import.meta.url)
      ),
      "@openlimiter/adapters": fileURLToPath(
        new URL("./.test-dist/packages/adapters/src/index.js", import.meta.url)
      ),
      "@openlimiter/ui": fileURLToPath(
        new URL("./.test-dist/packages/ui/src/index.js", import.meta.url)
      )
    }
  },
  test: {
    include: [".test-dist/packages/*/test/**/*.test.js"],
    environment: "node",
    pool: "threads",
    /* Several tests enforce real wall clock budgets for cache and hook paths.
       Running unrelated files at the same time turns runner contention into
       the value under test. One worker keeps every budget and assertion intact
       while measuring each product path without sibling suite interference. */
    fileParallelism: false,
    coverage: {
      include: [".test-dist/packages/core/src/**/*.js", ".test-dist/packages/connectors/src/**/*.js"],
      reporter: ["text", "json-summary"]
    }
  }
});
