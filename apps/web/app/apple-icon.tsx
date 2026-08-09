import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { tile } from "@/lib/image-palette";

/**
 * The home screen icon. Same tile treatment as the favicon, at the size iOS
 * and Android ask for: the real mark in white on solid brand blue.
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
