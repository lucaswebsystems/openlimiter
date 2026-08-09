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
          background: "#0a0e1a",
          color: "white",
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
              background: "#9ee7ff",
              borderRadius: "50%",
              color: "#0a0e1a",
              display: "flex",
              fontSize: 62,
              fontWeight: 800,
              height: 96,
              justifyContent: "center",
              width: 96,
            }}
          >
            O
          </div>
          <div style={{ fontSize: 76, fontWeight: 800, letterSpacing: -2 }}>
            OpenLimiter
          </div>
        </div>
        <div
          style={{
            color: "#9ee7ff",
            fontSize: 42,
            fontWeight: 600,
            marginTop: 52,
          }}
        >
          Quota awareness for AI coding agents
        </div>
        <div
          style={{
            color: "#a9b4cc",
            fontSize: 25,
            letterSpacing: 1,
            marginTop: 28,
          }}
        >
          open source, local first
        </div>
      </div>
    ),
    size,
  );
}
