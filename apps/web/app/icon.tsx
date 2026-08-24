import { ImageResponse } from "next/og";
import { BRAND_MARK_DATA_URI } from "@/lib/brand.generated";
import { iconMark } from "@/lib/image-palette";

/**
 * The favicon: the frozen brand mark, in the brand blue, and nothing else.
 *
 * No tile, no ground, no padding. The artwork is cropped to the mark's own
 * outer edge and drawn to all four sides of the canvas, so the tab shows the
 * mark from the header rather than a blue square with something inside it. A
 * transparent ground also lets the mark sit on whatever the browser's own tab
 * strip happens to be, light or dark, instead of carrying a near black patch
 * into a light one.
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
          src={BRAND_MARK_DATA_URI}
          width={size.width}
          height={size.height}
          alt=""
        />
      </div>
    ),
    size,
  );
}
