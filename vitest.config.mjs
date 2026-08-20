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
    coverage: {
      include: [".test-dist/packages/core/src/**/*.js", ".test-dist/packages/connectors/src/**/*.js"],
      reporter: ["text", "json-summary"]
    }
  }
});
