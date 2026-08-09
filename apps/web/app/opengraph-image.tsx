import { ImageResponse } from "next/og";
import { imagePalette } from "@/lib/image-palette";

export const alt = "OpenLimiter, quota awareness for AI coding agents";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "flex-start",
          background: imagePalette.canvas,
          color: imagePalette.heading,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "center",
          padding: "84px 96px",
          width: "100%",
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 28 }}>
          <div
            style={{
              alignItems: "center",
              background: imagePalette.heading,
              borderRadius: "50%",
              color: imagePalette.canvas,
              display: "flex",
              fontSize: 58,
              fontWeight: 700,
              height: 90,
              justifyContent: "center",
              width: 90,
            }}
          >
            O
          </div>
          <div
            style={{
              color: imagePalette.heading,
              fontSize: 72,
              fontWeight: 600,
              letterSpacing: -2,
            }}
          >
            OpenLimiter
          </div>
        </div>
        <div
          style={{
            color: imagePalette.heading,
            fontSize: 40,
            fontWeight: 500,
            marginTop: 48,
          }}
        >
          Know your limits. Route around them.
        </div>
        <div
          style={{
            color: imagePalette.body,
            fontSize: 24,
            letterSpacing: 0.5,
            marginTop: 24,
          }}
        >
          Open source, local first, cross platform
        </div>
      </div>
    ),
    size,
  );
}
