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
        <div style={{ alignItems: "center", display: "flex", gap: 24 }}>
          <div
            style={{
              alignItems: "center",
              background: imagePalette.accent,
              borderRadius: 20,
              color: imagePalette.onAccent,
              display: "flex",
              fontSize: 44,
              fontWeight: 600,
              height: 84,
              justifyContent: "center",
              width: 84,
            }}
          >
            OL
          </div>
          <div
            style={{
              color: imagePalette.heading,
              fontSize: 60,
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
            fontSize: 46,
            fontWeight: 500,
            letterSpacing: -1,
            marginTop: 52,
          }}
        >
          Know which subscription still has room.
        </div>
        <div
          style={{
            color: imagePalette.body,
            fontSize: 24,
            marginTop: 22,
          }}
        >
          Open source, local first, zero telemetry
        </div>
      </div>
    ),
    size,
  );
}
