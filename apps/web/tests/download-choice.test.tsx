import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadChoice, detectedPlatform } from "@/components/download-choice";
import { render, type Mounted } from "./render";

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
};

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("download choice", () => {
  it("distinguishes mobile, desktop and unknown platform signals", () => {
    expect(detectedPlatform({ platform: "MacIntel", userAgent: "Mozilla/5.0", maxTouchPoints: 5 })).toBe("mobile");
    expect(detectedPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 Android", maxTouchPoints: 0 })).toBe("mobile");
    expect(detectedPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 Windows NT", maxTouchPoints: 0 })).toBe("windows");
    expect(detectedPlatform({ platform: "Plan9", userAgent: "Unknown", maxTouchPoints: 0 })).toBe("unknown");
  });

  it("renders equal platform destinations and the real capture fallback", () => {
    mounted = render(createElement(DownloadChoice, props));
    expect([...mounted.container.querySelectorAll("article")].map((node) => node.id)).toEqual(["windows", "macos", "linux"]);
    expect(mounted.container.querySelectorAll('a[href^="https://example.test/"]').length).toBe(4);
    expect(mounted.container.querySelector("picture source[type='image/webp']")?.getAttribute("srcset")).toContain("desktop-home@2x.webp");
    const image = mounted.container.querySelector("picture img");
    expect(image?.getAttribute("src")).toBe("/screenshots/desktop-home.png");
    expect(image?.getAttribute("width")).toBe("2000");
    expect(image?.getAttribute("height")).toBe("2410");
    expect(mounted.container.querySelectorAll("article a svg")).toHaveLength(3);
  });
});
