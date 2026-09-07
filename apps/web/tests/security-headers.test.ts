import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Referrer-Policy rules in next.config.ts, read as source rather than
 * imported.
 *
 * next.config.ts pulls in next-intl's build plugin, which starts real file
 * watchers and extraction compilers as a side effect of being constructed;
 * importing the module here would carry all of that into a unit test run for
 * no reason. What actually matters, that every route which carries a one time
 * code in its query string says no-referrer, is just as provable by reading
 * the file's own text.
 */

/* Vitest runs this suite from the app root, so the file sits one join away:
   no URL parsing, and nothing jsdom's own URL class could disagree with node
   about. */
function configSource(): string {
  return readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
}

/** The `source` string of the header rule block that follows this route. */
function headerRuleFor(route: string): string | null {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `source:\\s*"${escaped}"[\\s\\S]{0,200}?headers:\\s*\\[([\\s\\S]{0,200}?)\\]`,
    "u",
  ).exec(configSource());
  return match?.[1] ?? null;
}

describe("no-referrer on every route that carries a one time code", () => {
  it.each([
    "/app/pair",
    "/app/pair/api/:path*",
    "/app/cli",
    "/app/openrouter/callback",
  ])("says no-referrer for %s", (route) => {
    const rule = headerRuleFor(route);
    expect(rule, `no header rule found for ${route}`).not.toBeNull();
    expect(rule).toContain("Referrer-Policy");
    expect(rule).toContain("no-referrer");
  });
});
