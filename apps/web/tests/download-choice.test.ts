import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadChoice, detectedPlatform } from "@/components/download-choice";
import { flush, render, type Mounted } from "./render";

const props = {
  windowsHref: "https://example.test/windows",
  linuxHref: "https://example.test/linux",
  macosHref: "https://example.test/macos",
  otherHref: "https://example.test/other",
  windowsLabel: "Download for Windows",
  linuxLabel: "Download for Linux",
  macosLabel: "Download for macOS",
  otherLabel: "Other platforms",
  windowsSummary: "Windows summary",
  macosSummary: "macOS summary",
  linuxSummary: "Linux summary",
  versionLine: "Version {version}",
  releaseNotesLabel: "Release notes",
  releaseNotesHref: "https://example.test/release",
  detectedLabel: "Detected",
  previewTitle: "OpenLimiter desktop application",
  previewAlt: "OpenLimiter desktop home screen",
  mobile: {
    title: "OpenLimiter runs on your computer.",
    body: "Send this page to yourself.",
    share: "Share this page",
    copy: "Copy link",
    copied: "Link copied",
    source: "View source on GitHub",
    sourceHref: "https://example.test/source",
  },
};

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

let mounted: Mounted | null = null;
let restore: (() => void) | null = null;

/** Shadows navigator's own getters for one test; deleting the shadow restores them. */
function stubNavigator(values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(navigator, key, { value, configurable: true });
  }
  restore = () => {
    for (const key of Object.keys(values)) delete (navigator as unknown as Record<string, unknown>)[key];
  };
}

const primaries = (root: HTMLElement) => [...root.querySelectorAll(".bg-primary-fill")].filter((node) => node.tagName !== "SPAN");

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restore?.();
  restore = null;
});

describe("download choice", () => {
  it("distinguishes mobile, desktop and unknown platform signals", () => {
    expect(detectedPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0", maxTouchPoints: 5 })).toBe("mobile");
    expect(detectedPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 Android", maxTouchPoints: 0 })).toBe("mobile");
    expect(detectedPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 Windows NT", maxTouchPoints: 0 })).toBe("windows");
    expect(detectedPlatform({ platform: "Plan9", userAgent: "Unknown", maxTouchPoints: 0 })).toBe("unknown");
  });

  it("offers three equal secondary choices and the real capture when the platform is unknown", () => {
    stubNavigator({ platform: "Plan9", userAgent: "Unknown", maxTouchPoints: 0 });
    mounted = render(createElement(DownloadChoice, props));
    expect([...mounted.container.querySelectorAll("article")].map((node) => node.id)).toEqual(["windows", "macos", "linux"]);
    expect(primaries(mounted.container)).toHaveLength(0);
    expect(mounted.container.querySelectorAll('a[href^="https://example.test/"]').length).toBe(5);
    expect(mounted.container.querySelector("picture source[type='image/webp']")?.getAttribute("srcset")).toContain("desktop-app@2x.webp");
    const image = mounted.container.querySelector("picture img");
    expect(image?.getAttribute("src")).toBe("/screenshots/desktop-app.png");
    expect([image?.getAttribute("width"), image?.getAttribute("height")]).toEqual(["2560", "1600"]);
  });

  it("makes the detected desktop platform the one primary button, carrying the visit's tags", () => {
    stubNavigator({ platform: "Win32", userAgent: WINDOWS, maxTouchPoints: 0 });
    window.history.replaceState(null, "", "/download?utm_source=reddit&utm_content=a");
    try {
      mounted = render(createElement(DownloadChoice, props));
    } finally {
      window.history.replaceState(null, "", "/");
    }
    const primary = primaries(mounted.container);
    expect(primary).toHaveLength(1);
    expect(primary[0]?.getAttribute("href")).toBe(`${props.windowsHref}?utm_source=reddit&utm_content=a`);
    expect(mounted.container.querySelector("#windows")?.textContent).toContain("Detected");
  });

  it("shows a phone a single card that shares the page instead of three installers", async () => {
    const share = vi.fn(async () => undefined);
    stubNavigator({ platform: "iPhone", userAgent: IPHONE, maxTouchPoints: 5, share });
    mounted = render(createElement(DownloadChoice, props));
    expect(mounted.container.querySelectorAll("article")).toHaveLength(0);
    expect(mounted.container.querySelector("#mobile h2")?.textContent).toBe(props.mobile.title);
    expect(mounted.container.querySelector(`a[href="${props.mobile.sourceHref}"]`)?.textContent).toContain(props.mobile.source);
    const button = mounted.container.querySelector<HTMLButtonElement>("#mobile button");
    expect(button?.textContent).toBe(props.mobile.share);
    button?.click();
    await flush();
    expect(share).toHaveBeenCalledWith({ title: document.title, url: window.location.href });
  });

  it("copies the link where the browser has no share sheet", async () => {
    const writeText = vi.fn(async () => undefined);
    stubNavigator({ platform: "Linux armv8l", userAgent: "Mozilla/5.0 (Linux; Android 15)", maxTouchPoints: 5, share: undefined, clipboard: { writeText } });
    mounted = render(createElement(DownloadChoice, props));
    const button = mounted.container.querySelector<HTMLButtonElement>("#mobile button");
    expect(button?.textContent).toBe(props.mobile.copy);
    button?.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(button?.textContent).toBe(props.mobile.copied);
  });
});
