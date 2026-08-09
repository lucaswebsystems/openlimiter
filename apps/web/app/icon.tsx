import { ImageResponse } from "next/og";

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

