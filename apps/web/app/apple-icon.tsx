import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { iconMark } from "@/lib/image-palette";

/**
 * The home screen icon, at the size iOS asks for.
 *
 * Same treatment as the browser tab: the ring in the brand blue, cropped to its
 * own outer edge, edge to edge, with nothing behind it. iOS rounds this into a
 * squircle and composites it over a light ground, and the brand blue carries
 * easily against that. The rounding is safe for this artwork specifically: a
 * circle inscribed in a square only touches the four edge midpoints, and a
 * squircle mask only takes corners, so nothing of the ring is ever cut.
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
  /* The ring sits at 60 percent of the tile on a dark ground, the way the
     Claude and ChatGPT home screen icons breathe, instead of edge to edge:
     the founder photographed the old crop next to them and it read as a
     mistake (2026-08-11). */
  const markSize = Math.round(size.width * 0.6);
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#16161a",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={markDataUri(iconMark.mark, "full", "ring")}
          width={markSize}
          height={markSize}
          alt=""
        />
      </div>
    ),
    size,
  );
}
