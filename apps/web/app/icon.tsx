import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { tile } from "@/lib/image-palette";

/**
 * The favicon: the real mark, inverted to white on the brand blue tile.
 *
 * The tile treatment wins over the mark on bare canvas because a favicon has
 * no control over the browser chrome behind it, and the ring has to stay
 * legible on light tabs and dark tabs alike.
 */
export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

export default function Icon() {
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
