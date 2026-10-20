import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * One accessible primary outside the hero (audit U62, U77 and the site part
 * of U69). White on the brand blue measures 3.75:1, short of the 4.5:1 a
 * label needs; white on the mark blue measures 4.8:1 and on its hover 6.2:1.
 * The hero is locked by order, so it keeps its own classes and is the one
 * place white text may still sit on the brand blue.
 */

const web = process.cwd();
const read = (path: string) => readFileSync(resolve(web, path), "utf8");
const tokens = read("../../packages/ui/src/tokens.css");
const rootBlock = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("}", tokens.indexOf(":root {")));

function token(name: string): string {
  const value = rootBlock.match(new RegExp(`--${name}: (#[0-9a-fA-F]{6});`, "u"))?.[1];
  if (value === undefined) throw new Error(`no literal for --${name}`);
  return value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(left: string, right: string): number {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

function sources(directory: string): string[] {
  return readdirSync(resolve(web, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sources(path);
    return /\.(tsx|ts|css)$/u.test(entry.name) ? [path.replaceAll("\\", "/")] : [];
  });
}

describe("one accessible primary outside the hero", () => {
  it("the mark blue and its hover carry a white label at AA, the brand blue does not", () => {
    expect(contrast(token("ol-primary"), token("ol-on-primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ol-primary-hover"), token("ol-on-primary"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ol-brand"), "#ffffff")).toBeLessThan(4.5);
  });

  it("no filled control outside the hero puts white text on the brand blue", () => {
    const offenders = [...sources("app"), ...sources("components")]
      .filter((path) => path !== "components/hero.tsx")
      .flatMap((path) => read(path).split("\n").map((line, index) => [path, index + 1, line] as const))
      .filter(([, , line]) => /text-on-accent\b|color: var\(--ol-on-accent\)/u.test(line))
      .map(([path, line]) => `${path}:${line}`);
    expect(offenders).toEqual([]);
    /* The shared Button and ButtonLink accent tone is the mark blue. */
    expect(read("components/ui.tsx")).toMatch(/accent: "border-transparent bg-primary text-on-primary hover:bg-primary-hover"/u);
  });

  it("the hub's primary control and the site's announcement bar use the mark blue", () => {
    const hub = read("app/app/theme.css");
    const primary = hub.match(/\.ol-control-primary \{([^}]*)\}/u)?.[1] ?? "";
    expect(primary).toMatch(/background: var\(--ol-primary\);/u);
    expect(primary).toMatch(/color: var\(--ol-on-primary\);/u);
    expect(hub.match(/\.ol-control-primary:hover \{([^}]*)\}/u)?.[1] ?? "").toMatch(/background: var\(--ol-primary-hover\);/u);
    expect(read("app/globals.css")).toMatch(/--ol-announce: var\(--ol-primary\);/u);
  });

  it("the hero keeps its own buttons exactly as they were", () => {
    const hero = read("components/hero.tsx");
    expect(hero.match(/!bg-accent-solid !text-on-accent hover:!bg-accent-solid-hover/gu)).toHaveLength(2);
  });
});
