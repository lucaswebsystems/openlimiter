import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The web application's own test runner.
 *
 * It is deliberately small. What is worth testing here is the logic that
 * decides things without a network: the pairing state machine, the plan states
 * the Pro portal draws, the device session this browser keeps, and the meter
 * contract the paired phone parses. Every one of those is a pure function or a
 * function over local storage, so a jsdom document and nothing else is enough.
 *
 * No test here makes a request. The transport in lib/pro-device.ts is the only
 * module that fetches, and the state machine takes a status and a body rather
 * than a Response, which is exactly so these files never need a server.
 */
export default defineConfig({
  /*
   * The automatic JSX runtime, which the application already uses.
   *
   * tsconfig.json leaves JSX alone for Next to compile, so the transform here
   * has to be told which runtime to use; without this a component mounted in a
   * test reaches for a React global that the source never imports. Nothing
   * else about the build changes.
   */
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
});
