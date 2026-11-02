import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const theme = readFileSync("app/app/theme.css", "utf8");
const navSheet = readFileSync("components/nav-sheet.tsx", "utf8");

const touch = "var(--ol-control-height-touch)";

function phoneBlock(needle: string): string {
  const blocks = [...theme.matchAll(/@media \(max-width: 479px\) \{([\s\S]*?)\n\}/gu)];
  const block = blocks.map((match) => match[0]).find((candidate) => candidate.includes(needle));
  if (block === undefined) throw new Error(`no 479px block containing ${needle}`);
  return block;
}

function ruleBody(source: string, selector: string): string {
  const body = source.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "u"))?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return body;
}

describe("phone tap targets", () => {
  it("phone gear is at least 44 px through the touch token", () => {
    const body = ruleBody(theme, ".ol-phone-gear");
    expect(body).toMatch(new RegExp(`width:\\s*${touch.replace(/[()$]/g, "\\$&")};`, "u"));
    expect(body).toMatch(new RegExp(`height:\\s*${touch.replace(/[()$]/g, "\\$&")};`, "u"));
  });

  it("theme choice buttons are at least 44 px tall through the touch token", () => {
    const body = ruleBody(theme, ".ol-theme-choice button");
    expect(body).toMatch(new RegExp(`min-height:\\s*${touch.replace(/[()$]/g, "\\$&")};`, "u"));
  });

  it("icon controls are at least 44 px on phones through the touch token", () => {
    const block = phoneBlock(".ol-icon-control");
    const body = ruleBody(block, ".ol-icon-control");
    expect(body).toMatch(new RegExp(`width:\\s*${touch.replace(/[()$]/g, "\\$&")};`, "u"));
    expect(body).toMatch(new RegExp(`min-height:\\s*${touch.replace(/[()$]/g, "\\$&")};`, "u"));
  });

  it("card grips are at least 44 px on phones through the touch token", () => {
    const block = phoneBlock(".ol-card-grip");
    const body = ruleBody(block, ".ol-card-grip");
    expect(body).toMatch(new RegExp(`width:\\s*${touch.replace(/[()$]/g, "\\$&")};`, "u"));
    expect(body).toMatch(new RegExp(`height:\\s*${touch.replace(/[()$]/g, "\\$&")};`, "u"));
  });

  it("unifies command-bar control heights on phones", () => {
    const block = phoneBlock(".ol-commandbar-actions");
    const body = ruleBody(block, ".ol-commandbar-actions");
    // The block contains two .ol-commandbar-actions rules; check the height one exists.
    expect(block).toMatch(/\.ol-commandbar-actions\s*\{[^}]*--ol-control-height:\s*var\(--ol-control-height-touch\);[^}]*\}/u);
  });

  it("does not leave raw 2.75rem tap target values", () => {
    expect(theme).not.toMatch(/2\.75rem/);
  });

  it("removes the redundant narrow-width control-height overrides", () => {
    const narrow409 = theme.match(/@media \(max-width: 409px\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
    const narrow359 = theme.match(/@media \(max-width: 359px\) \{([\s\S]*?)\n\}/u)?.[1] ?? "";
    expect(narrow409).not.toMatch(/--ol-control-height/);
    expect(narrow359).not.toMatch(/--ol-control-height/);
  });

  it("nav sheet trigger is at least 44 px", () => {
    expect(navSheet).toContain("h-11 w-11");
  });
});
