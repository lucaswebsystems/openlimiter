import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { tile } from "@/lib/image-palette";

/**
 * The home screen icon, at the size iOS asks for.
 *
 * This is the approved tile artwork, the ring reversed out of a solid brand
 * blue square, which is the same treatment as assets/brand and the same as the
 * PNGs the web application manifest points at, so every home screen surface
 * carries one icon. The browser tab is the one place that departs from it, and
 * app/icon.tsx says why.
 *
 * 180 pixels is far above the size where the arcs close up, so this one draws
 * the full eight segment ring with its whole taper intact.
 */
export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  const mark = Math.round(size.width * tile.markRatio);

  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: tile.background,
          borderRadius: Math.round(size.width * tile.radiusRatio),
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={markDataUri(tile.mark)} width={mark} height={mark} alt="" />
      </div>
    ),
    size,
  );
}
