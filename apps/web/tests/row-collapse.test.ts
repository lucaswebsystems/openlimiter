import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const theme = readFileSync(resolve(process.cwd(), "app/app/theme.css"), "utf8");

function mediaBlocks(maxWidth: number): string[] {
  const re = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/gu;
  return [...theme.matchAll(re)].map((match) => match[1] ?? "");
}

function ruleBody(block: string, selector: string): string {
  return block.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "u"))?.[1] ?? "";
}

describe("row collapse breakpoint", () => {
  it("collapses .ol-list-row inside a 767px media query", () => {
    const block = mediaBlocks(767).find((candidate) => /\.ol-list-row \{/.test(candidate)) ?? "";
    const body = ruleBody(block, ".ol-list-row");
    expect(body).toMatch(/grid-template-columns: auto minmax\(0, 1fr\) auto;/u);
  });

  it("collapses .ol-directory-row inside a 767px media query", () => {
    const block = mediaBlocks(767).find((candidate) => /\.ol-directory-row \{/.test(candidate)) ?? "";
    const body = ruleBody(block, ".ol-directory-row");
    expect(body).toMatch(/grid-template-columns: minmax\(0, 1fr\) auto;/u);
  });
});