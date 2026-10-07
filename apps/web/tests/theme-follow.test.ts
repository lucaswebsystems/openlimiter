import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FollowSystemTheme } from "@/components/follow-system-theme";
import { applyTheme, themeArmScript, THEME_STORAGE_KEY } from "@/lib/theme";

describe("phone theme following", () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.head.innerHTML = "";
  });

  it("arms standalone system following while leaving an ordinary site visit untouched", () => {
    expect(themeArmScript).toContain("display-mode: standalone");
    expect(themeArmScript).toContain("prefers-color-scheme: light");
    expect(themeArmScript).toContain("theme-color");
  });

  it("stores explicit choices and removes the choice for System", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#080b10">';
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    applyTheme("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#080b10");
    applyTheme("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#f4f7fb");
  });

  it("follows media changes in standalone mode and preserves a stored override", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#080b10">';
    let light = false;
    let onChange: (() => void) | undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("display-mode") ? true : light,
        addEventListener: (_name: string, listener: () => void) => { if (query.includes("prefers-color")) onChange = listener; },
        removeEventListener: vi.fn(),
      })),
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(createElement(FollowSystemTheme)));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    light = true;
    act(() => onChange?.());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe("#f4f7fb");
    applyTheme("dark");
    act(() => onChange?.());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    act(() => root.unmount());
    container.remove();
  });
});
