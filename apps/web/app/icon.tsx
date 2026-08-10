import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { iconMark } from "@/lib/image-palette";

/**
 * The favicon: the brand mark, in the brand blue, and nothing else.
 *
 * No tile, no ground, no padding. The artwork is cropped to the ring's own
 * outer edge and drawn to all four sides of the canvas, so the tab shows the
 * mark from the header rather than a blue square with something inside it. A
 * transparent ground also lets the ring sit on whatever the browser's own tab
 * strip happens to be, light or dark, instead of carrying a near black patch
 * into a light one.
 *
 * The four segment telling is used rather than the full eight. A browser paints
 * this at 16 points as often as at 32, and at that size the eight degree gaps
 * between eight arcs are under a pixel and close up into a solid circle. Same
 * geometry, same radius, same blue, fewer and thicker segments: see
 * MARK_SEGMENTS_SMALL in lib/brand.ts.
 *
 * Rendered at 64 pixels and left for the browser to bring down. A tab is 16
 * points, so a two times display already wants 32 and a three times display
 * wants 48. Handing over the largest of those and letting the browser resample
 * costs a few hundred bytes once and is sharp on every one of them.
 */
export const size = {
  width: 64,
  height: 64,
};

export const contentType = "image/png";

export default function Icon() {
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
          src={markDataUri(iconMark.mark, "small", "ring")}
          width={size.width}
          height={size.height}
          alt=""
        />
      </div>
    ),
    size,
  );
}
