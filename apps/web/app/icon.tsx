import { ImageResponse } from "next/og";
import { imagePalette } from "@/lib/image-palette";

export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

export default function Icon() {
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
        <div
          style={{
            alignItems: "center",
            background: imagePalette.accent,
            borderRadius: 7,
            color: imagePalette.onAccent,
            display: "flex",
            fontSize: 16,
            fontWeight: 700,
            height: 22,
            justifyContent: "center",
            width: 22,
          }}
        >
          O
        </div>
      </div>
    ),
    size,
  );
}
