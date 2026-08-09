import { ImageResponse } from "next/og";

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
          background: "#0a0a0b",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "#ededed",
            borderRadius: "50%",
            color: "#0a0a0b",
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

