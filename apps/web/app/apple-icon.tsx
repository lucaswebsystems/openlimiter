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
  return new ImageResponse(
    (
      <div
        style={{
          background: iconMark.background,
          display: "flex",
          height: "100%",
          width: "100%",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={markDataUri(iconMark.mark, "full", "ring")}
          width={size.width}
          height={size.height}
          alt=""
        />
      </div>
    ),
    size,
  );
}
