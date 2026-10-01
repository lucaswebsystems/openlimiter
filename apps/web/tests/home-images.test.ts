import { fileURLToPath } from "node:url";
import path from "node:path";
import { createElement } from "react";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PRODUCT_SHOTS, ProductShot } from "../components/device-frame";
import { PhonePanels } from "../components/phone-panels";
import { render, type Mounted } from "./render";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

// The image component also exports a section that imports SiteLink. The
// standalone image tests do not run inside Next's localized router.
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

  it("shows the edge tab and its panel, and no retired Rail capture is left to serve", () => {
    expect(Object.keys(PRODUCT_SHOTS)).toEqual(expect.arrayContaining(["edge-tab", "edge-panel"]));
    const screenshots = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/screenshots");
    expect(readdirSync(screenshots).filter((file) => /rail/iu.test(file))).toEqual([]);
    expect(Object.keys(PRODUCT_SHOTS).filter((name) => /rail/iu.test(name))).toEqual([]);
  });

  it("registers and renders all four phone views", () => {
    const phones = Object.keys(PRODUCT_SHOTS).filter((name) => name.startsWith("phone-"));
    expect(phones).toEqual(["phone-1", "phone-2", "phone-3", "phone-4"]);
    mounted = render(createElement(PhonePanels));
    const images = [...mounted.container.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(images).toEqual(phones.map((name) => `/screenshots/${name}.png`));
  });

  it("declares every web manifest screenshot at its real size", () => {
    const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public");
    const manifest = JSON.parse(readFileSync(path.join(publicDir, "manifest.webmanifest"), "utf8")) as { screenshots: { src: string; sizes: string }[] };
    for (const shot of manifest.screenshots) {
      const png = readFileSync(path.join(publicDir, shot.src));
      expect(shot.sizes, shot.src).toBe(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    }
  });

  it("keeps every display cap at or below half the real capture width", () => {
    for (const [name, shot] of Object.entries(PRODUCT_SHOTS)) {
      for (const theme of ["", "-light"]) {
        // Real file paths: under jsdom, import.meta.url is not a file URL.
        const base = path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/screenshots", `${name}${theme}`);
        if (name === "phone-4" && !existsSync(`${base}.png`)) continue;
        const png = readFileSync(`${base}.png`);
        expect(png.readUInt32BE(16)).toBe(shot.width);
        expect(png.readUInt32BE(20)).toBe(shot.height);
        expect(shot.maxWidth * 2).toBeLessThanOrEqual(shot.width);
        for (const density of name.startsWith("phone-") ? [1, 2, 3] : [1, 2]) {
          expect(existsSync(`${base}@${density}x.webp`)).toBe(true);
        }
      }
    }
  });
});
