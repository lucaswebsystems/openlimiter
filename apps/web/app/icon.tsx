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
          background: "#0a0e1a",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "#9ee7ff",
            borderRadius: "50%",
            color: "#0a0e1a",
            display: "flex",
            fontSize: 17,
            fontWeight: 800,
            height: 24,
            justifyContent: "center",
            width: 24,
          }}
        >
          O
        </div>
      </div>
    ),
    size,
  );
}
