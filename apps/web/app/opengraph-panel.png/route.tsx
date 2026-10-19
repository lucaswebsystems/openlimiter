import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { BRAND_MARK_DATA_URI } from "@/lib/brand.generated";
import { imagePalette } from "@/lib/image-palette";

/**
 * The social card for the home page and /download: the edge panel, and one line.
 *
 * The panel is the real capture in public/screenshots, cropped to the part of
 * it that carries no third party mark: every provider logo sits in one column
 * at the panel's left edge, ending at x 141, and the names start at x 158, so
 * the crop starts between the two and the cut fades into the canvas, which also
 * reads as the panel opening from the left edge of the screen, the way it does
 * on a desktop. The crop stops above the OpenRouter row. The line is the home
 * page's own rail title, in English, like every card on this site.
 *
 * The wordmark is set as text beside the mark rather than taken from the
 * lockup file, because the renderer has no font for the lockup's own text.
 *
 * It is built once at build time and served as a file; the path carries an
 * extension so the locale middleware never sees it. A recapture that moves the
 * panel needs CROP checked again against the new picture.
 */
export const dynamic = "force-static";

const SIZE = { width: 1200, height: 630 };

/** The panel picture is 1120 by 1180; this is the mark free window into it. */
const SOURCE = { width: 1120, height: 1180 };
const CROP = { left: 146, top: 164, width: 606, height: 776 };
const SCALE = SIZE.height / CROP.height;

const LINE = "One small tab. Your limits and agents on hover.";

export async function GET() {
  const panel = await readFile(path.join(process.cwd(), "public", "screenshots", "edge-panel.png"));
  const src = `data:image/png;base64,${panel.toString("base64")}`;

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", background: imagePalette.canvas }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            width: 640,
            paddingLeft: 72,
            paddingRight: 48,
            gap: 36,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <img src={BRAND_MARK_DATA_URI} width={52} height={52} alt="" />
            <div style={{ display: "flex", fontSize: 44, color: imagePalette.heading }}>OpenLimiter</div>
          </div>
          <div style={{ display: "flex", fontSize: 58, lineHeight: 1.18, color: imagePalette.heading }}>{LINE}</div>
        </div>
        <div
          style={{
            display: "flex",
            position: "relative",
            overflow: "hidden",
            width: Math.round(CROP.width * SCALE),
            height: SIZE.height,
          }}
        >
          <img
            src={src}
            alt=""
            width={Math.round(SOURCE.width * SCALE)}
            height={Math.round(SOURCE.height * SCALE)}
            style={{
              position: "absolute",
              left: -Math.round(CROP.left * SCALE),
              top: -Math.round(CROP.top * SCALE),
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: 12,
              height: SIZE.height,
              backgroundImage: `linear-gradient(to right, ${imagePalette.canvas}, rgba(8, 11, 16, 0))`,
            }}
          />
        </div>
      </div>
    ),
    SIZE,
  );
}
