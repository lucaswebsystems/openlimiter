import { createElement } from "react";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_SHOTS, ProductShot } from "../components/device-frame";
import { render, type Mounted } from "./render";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  delete document.documentElement.dataset.theme;
});

describe("home product image delivery", () => {
  it("changes the selected source when the explicit site theme changes", async () => {
    document.documentElement.dataset.theme = "dark";
    mounted = render(createElement(ProductShot, { name: "desktop-home", alt: "Home capture" }));
    const picture = mounted.container.querySelector("picture")!;
    expect(picture.querySelectorAll("img")).toHaveLength(1);
    expect(picture.querySelector("source")!.media).toBe("not all");
    await mounted.run(async () => {
      document.documentElement.dataset.theme = "light";
      await Promise.resolve();
    });
    expect(picture.querySelector("source")!.media).toBe("all");
    expect(picture.querySelector("img")!.getAttribute("src")).toBe("/screenshots/desktop-home-light.png");
    expect(picture.querySelector("img")!.getAttribute("loading")).toBe("lazy");
    expect(picture.querySelector("img")!.getAttribute("fetchpriority")).toBeNull();
  });

  it("provides three phone densities and reserves the original aspect ratio", () => {
    mounted = render(createElement(ProductShot, { name: "phone-1", alt: "Phone meters" }));
    const picture = mounted.container.querySelector("picture")!;
    for (const source of picture.querySelectorAll("source")) {
      expect(source.type).toBe("image/webp");
      expect(source.srcset).toMatch(/@1x\.webp 1x, .*@2x\.webp 2x, .*@3x\.webp 3x/);
    }
    const img = picture.querySelector("img")!;
    expect([img.width, img.height]).toEqual([1170, 2532]);
    expect(img.alt).toBe("Phone meters");
  });

  it("keeps every display cap at or below half the real capture width", () => {
    for (const [name, shot] of Object.entries(PRODUCT_SHOTS)) {
      for (const theme of ["", "-light"]) {
        const base = new URL(`../public/screenshots/${name}${theme}`, import.meta.url);
        const png = readFileSync(new URL(`${base.href}.png`));
        expect(png.readUInt32BE(16)).toBe(shot.width);
        expect(png.readUInt32BE(20)).toBe(shot.height);
        expect(shot.maxWidth * 2).toBeLessThanOrEqual(shot.width);
        for (const density of name.startsWith("phone-") ? [1, 2, 3] : [1, 2]) {
          expect(existsSync(new URL(`${base.href}@${density}x.webp`))).toBe(true);
        }
      }
    }
  });
});
