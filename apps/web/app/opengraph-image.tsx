import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { imagePalette } from "@/lib/image-palette";

/**
 * The social card.
 *
 * It renders the real mark twice: once at lockup size next to the wordmark,
 * and once oversized and nearly transparent behind the copy, bled off the
 * right edge. Both come from the same eight arcs the header lockup draws.
 *
 * The type is the neutral sans that next/og bundles. The wordmark face is a
 * web font, and pulling a font binary into a card renderer is a build time
 * network dependency this route deliberately does not take.
 */
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
          background: imagePalette.canvas,
          color: imagePalette.heading,
          display: "flex",
          height: "100%",
          position: "relative",
          width: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            opacity: 0.1,
            position: "absolute",
            right: -150,
            top: 65,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={markDataUri(imagePalette.brand)} width={500} height={500} alt="" />
        </div>

        <div
          style={{
            alignItems: "flex-start",
            display: "flex",
            flexDirection: "column",
            height: "100%",
            justifyContent: "center",
            padding: "84px 96px",
            width: "100%",
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 22 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={markDataUri(imagePalette.brand)} width={84} height={84} alt="" />
            <div
              style={{
                color: imagePalette.heading,
                fontSize: 58,
                fontWeight: 600,
                letterSpacing: -1,
              }}
            >
              OpenLimiter
            </div>
          </div>

          {/* Satori has no line box model, so each line of the headline is its
              own element in a column. */}
          <div
            style={{
              color: imagePalette.heading,
              display: "flex",
              flexDirection: "column",
              fontSize: 60,
              fontWeight: 500,
              letterSpacing: -2,
              lineHeight: 1.1,
              marginTop: 54,
            }}
          >
            <div style={{ display: "flex" }}>Know which subscription</div>
            <div style={{ display: "flex" }}>still has room.</div>
          </div>

          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 14,
              marginTop: 34,
            }}
          >
            <div
              style={{
                background: imagePalette.accent,
                borderRadius: 999,
                height: 10,
                width: 10,
              }}
            />
            <div style={{ color: imagePalette.body, fontSize: 26 }}>
              Open source, local first, zero telemetry
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
