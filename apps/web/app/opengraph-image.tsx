import { ImageResponse } from "next/og";

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
          background: "#0a0a0b",
          color: "#ededed",
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
              background: "#ededed",
              borderRadius: "50%",
              color: "#0a0a0b",
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
          <div style={{ fontSize: 72, fontWeight: 600, letterSpacing: -2, color: "#ededed" }}>
            OpenLimiter
          </div>
        </div>
        <div
          style={{
            color: "#ededed",
            fontSize: 40,
            fontWeight: 500,
            marginTop: 48,
          }}
        >
          Know your limits. Route around them.
        </div>
        <div
          style={{
            color: "#8a8a92",
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

