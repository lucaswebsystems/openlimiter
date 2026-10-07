import { createElement } from "react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "@/lib/statusline-sample.json";
import { TerminalStatusline } from "../components/terminal-statusline";
import { render, type Mounted } from "./render";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
/* The caption comes from device-frame, which links through the localized navigation. */
vi.mock("@/i18n/navigation", async () => {
  const { createElement: element } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      element("a", { href, ...rest }, children as never),
  };
});

const CAPTURE_SOURCE = readFileSync("../../scripts/capture-screenshots.mjs", "utf8");

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe("live terminal status line", () => {
  it("keeps the three money cells and all four bands in the generated sample", () => {
    const text = sample.cells.flat().map((span) => span.text).join("");
    for (const cell of ["5h", "7d", "fable7d", "cx7d", "ag5h", "or $12.54", "oa $8.20", "an $3.10"]) expect(text).toContain(cell);
    for (const reading of ["37%", "58%", "63%", "82%", "~91%", "·1h12m", "·2d5h", "·4d19h", "·5d8h", "·2h26m"]) expect(text).toContain(reading);
    expect(new Set(sample.cells.flat().flatMap((span) => "band" in span ? [span.band] : []))).toEqual(
      new Set(["green", "yellow", "orange", "red"]),
    );
  });

  it("renders every real CLI cell and every separator", () => {
    mounted = render(createElement(TerminalStatusline, { caption: "Real renderer" }));
    expect(mounted.container.querySelectorAll("[data-statusline-cell]")).toHaveLength(sample.cells.length);
    expect(mounted.container.querySelectorAll("[data-statusline-separator]")).toHaveLength(sample.cells.length - 1);
    expect(mounted.container.querySelector("[data-statusline-row]")?.textContent).toBe(
      sample.cells.map((cell) => cell.map((span) => span.text).join("")).join(" | "),
    );
    expect(mounted.container.textContent).toContain("Real renderer");
    expect(mounted.container.textContent).toContain("demoData");
  });

  it("does not leave a dangling separator on the final sample cell", () => {
    mounted = render(createElement(TerminalStatusline, { caption: "Real renderer" }));
    const cells = [...mounted.container.querySelectorAll("[data-statusline-cell]")];
    expect(cells[0]?.textContent).not.toMatch(/^\s*\|/u);
    expect(cells.slice(1).every((cell) => cell.textContent?.startsWith(" | "))).toBe(true);
    expect(cells.slice(0, -1).every((cell) => !cell.textContent?.match(/\|\s*$/u))).toBe(true);
    expect(cells.at(-1)?.textContent).not.toMatch(/\|\s*$/u);
  });

  it("keeps the light terminal bands visibly distinct", () => {
    expect(CAPTURE_SOURCE).toContain(".band-yellow{color:#9a6700}");
    expect(CAPTURE_SOURCE).toContain(".band-orange{color:#bc4c00}");
    expect(CAPTURE_SOURCE).toContain(".band-red{color:#cf222e}");
    expect(CAPTURE_SOURCE).toContain('.cell{display:${wrap ? "inline-block" : "inline"};white-space:pre}');
    expect(CAPTURE_SOURCE).toContain("const lines = []");
    expect(CAPTURE_SOURCE).toContain("The terminal status line exceeds its frame");
  });

  it("keeps the live sample on one horizontally scrollable row", () => {
    mounted = render(createElement(TerminalStatusline, { caption: "Real renderer" }));
    const row = mounted.container.querySelector("[data-statusline-row]");
    expect(row?.className).toContain("overflow-x-auto");
    expect(row?.className).toContain("whitespace-nowrap");
    expect(row?.className).not.toContain("flex-wrap");
  });

  it("draws each meter as blocks one character cell per glyph, so no font fallback can misdraw it", () => {
    mounted = render(createElement(TerminalStatusline, { caption: "Real renderer" }));
    const meters = [...mounted.container.querySelectorAll("[data-statusline-meter]")];
    expect(meters.map((meter) => [...meter.children].map((part) => (part as HTMLElement).style.width))).toEqual([
      ["3ch", "7ch"],
      ["5ch", "5ch"],
      ["6ch", "4ch"],
      ["8ch", "2ch"],
      ["9ch", "1ch"],
    ]);
  });
});
