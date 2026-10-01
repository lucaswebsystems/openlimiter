import { createElement } from "react";
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

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe("live terminal status line", () => {
  it("keeps the three money cells and all four bands in the generated sample", () => {
    const text = sample.cells.flat().map((span) => span.text).join("");
    for (const cell of ["or $12.34", "oa $8.20", "an $3.10"]) expect(text).toContain(cell);
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
});
