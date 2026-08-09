import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { favicon } from "@/lib/image-palette";

/**
 * The favicon: the real brand mark, in the brand blue, on the site's own near
 * black ground.
 *
 * It is the same ring the header lockup draws, so the tab and the page agree.
 * The four segment telling is used rather than the full eight, because a
 * browser paints this at 16 pixels as often as at 32 and eight arcs with eight
 * degree gaps close up into a solid circle at that size. Same geometry, same
 * radius, same blue, fewer and thicker segments: see MARK_SEGMENTS_SMALL.
 */
export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

export default function Icon() {
  const mark = Math.round(size.width * favicon.markRatio);

  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: favicon.background,
          borderRadius: Math.round(size.width * favicon.radiusRatio),
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={markDataUri(favicon.mark, "small")} width={mark} height={mark} alt="" />
      </div>
    ),
    size,
  );
}
