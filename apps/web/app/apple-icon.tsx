import { ImageResponse } from "next/og";
import { BRAND_MARK_DATA_URI } from "@/lib/brand.generated";
import { imagePalette } from "@/lib/image-palette";

/**
 * The home screen icon, at the size iOS asks for.
 *
 * Same treatment as the browser tab: the mark in the brand blue, cropped to its
 * own outer edge, edge to edge, with nothing behind it. iOS rounds this into a
 * squircle and composites it over a light ground, and the brand blue carries
 * easily against that. The rounding is safe for this artwork specifically: a
 * circle inscribed in a square only touches the four edge midpoints, and a
 * squircle mask only takes corners, so nothing of the ring is ever cut.
 *
 * At 180 pixels, the continuous arc keeps the same confident silhouette as the
 * small browser and desktop icons.
 */
export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  /* The mark sits at 78 percent of the tile on a dark ground, the way the
     Claude and ChatGPT home screen icons breathe, instead of edge to edge:
     the founder photographed the old crop next to them and it read as a
     mistake (2026-08-11). */
  const markSize = Math.round(size.width * 0.78);
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: imagePalette.canvas,
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={BRAND_MARK_DATA_URI}
          width={markSize}
          height={markSize}
          alt=""
        />
      </div>
    ),
    size,
  );
}
