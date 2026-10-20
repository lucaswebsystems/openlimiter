// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PANEL_IMAGE, pageMetadata } from "../lib/metadata";

vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

describe("social cards", () => {
  it("gives /download the panel card and every other page the logo card", () => {
    const download = pageMetadata({ title: "Download", description: "d", route: "/download", locale: "en", image: PANEL_IMAGE });
    expect(download.openGraph?.images).toEqual([PANEL_IMAGE]);
    expect(download.twitter?.images).toEqual([{ url: "/opengraph-panel.png", alt: PANEL_IMAGE.alt, type: "image/png" }]);

    const docs = pageMetadata({ title: "Docs", description: "d", route: "/docs", locale: "en" });
    expect(docs.openGraph?.images).toEqual([expect.objectContaining({ url: "/opengraph-image" })]);
    expect(docs.twitter?.images).toEqual([expect.objectContaining({ url: "/twitter-image" })]);
  });
});
