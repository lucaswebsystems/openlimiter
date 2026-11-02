import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const theme = readFileSync("app/app/theme.css", "utf8");
const navSheet = readFileSync("components/nav-sheet.tsx", "utf8");

describe("phone tap targets", () => {
  it("phone gear is at least 44 px", () => {
    expect(theme).toMatch(/\.ol-phone-gear\s*\{[\s\S]*?width:\s*2\.75rem;[\s\S]*?height:\s*2\.75rem;/u);
  });

  it("theme choice buttons are at least 44 px tall", () => {
    expect(theme).toMatch(/\.ol-theme-choice button\s*\{[\s\S]*?min-height:\s*2\.75rem;/u);
  });

  it("icon controls are at least 44 px on phones", () => {
    expect(theme).toMatch(/@media \(max-width: 479px\) \{[\s\S]*?\.ol-icon-control\s*\{[\s\S]*?width:\s*2\.75rem;[\s\S]*?min-height:\s*2\.75rem;/u);
  });

  it("card grips are at least 44 px on phones", () => {
    expect(theme).toMatch(/@media \(max-width: 479px\) \{[\s\S]*?\.ol-card-grip\s*\{[\s\S]*?width:\s*2\.75rem;[\s\S]*?height:\s*2\.75rem;/u);
  });

  it("nav sheet trigger is at least 44 px", () => {
    expect(navSheet).toContain("h-11 w-11");
  });

  it("narrow breakpoints no longer shrink header controls below 44 px", () => {
    expect(theme).not.toMatch(/--ol-control-height:\s*2\.125rem/);
    expect(theme).not.toMatch(/--ol-control-height:\s*2rem;/);
  });
});
