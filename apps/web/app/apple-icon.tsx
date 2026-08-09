import { ImageResponse } from "next/og";
import { imagePalette } from "@/lib/image-palette";

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
            background: imagePalette.heading,
            borderRadius: "50%",
            color: imagePalette.canvas,
            display: "flex",
            fontSize: 88,
            fontWeight: 700,
            height: 136,
            justifyContent: "center",
            width: 136,
          }}
        >
          O
        </div>
      </div>
    ),
    size,
  );
}
