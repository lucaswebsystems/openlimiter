import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { markDataUri } from "@/lib/brand";
import { imagePalette } from "@/lib/image-palette";

/**
 * The social card: the logo, on the brand's own dark canvas, and nothing else.
 *
 * A link pasted into a chat is seen for about as long as it takes to scroll
 * past, so the card carries the one thing worth recognising at that speed. No
 * tagline, no address, no ornament. It is the lockup from assets/brand, in the
 * proportions that file draws it in, at about sixty percent of the card width.
 *
 * The wordmark is really Baloo 2 SemiBold, read from the copy of the font in
 * assets/fonts at render time. Satori has no font of its own beyond a plain
 * sans, so without this the card would set the wordmark in something that is
 * not the wordmark. The file is read off disk, never fetched: a card renderer
 * that makes a network call is a card renderer that fails when the network
 * does.
 */
export const alt = "OpenLimiter";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

/**
 * The lockup, in the units assets/brand/openlimiter-lockup.svg draws it in: a
 * 64 unit box for the mark, a 20 unit gap, then the wordmark at 58 units. One
 * scale factor carries all three, so the card cannot drift from the artwork.
 *
 * 2.392 puts the ink of the lockup at about 960 pixels across, eighty percent
 * of the 1200 pixel card. The founder judged the sixty percent version lost in
 * padding on a chat preview; a card this wide against a lockup this long can
 * never pad equally on all four sides without shrinking the logo, so big and
 * centred is what reads as balanced.
 */
const LOCKUP_SCALE = 2.392;
const MARK_BOX = Math.round(64 * LOCKUP_SCALE);
const GAP = Math.round(20 * LOCKUP_SCALE);
const FONT_SIZE = Math.round(58 * LOCKUP_SCALE);

/**
 * Baloo 2 hangs a much taller ascender than descender off its line box: 1078
 * against 524, per 1000 em units, with the capitals only 602 tall. Centring the
 * wordmark's line box against the mark therefore floats the capitals high,
 * because most of what the box is centring is air above them.
 *
 * This drops the type so the ring's centre and the middle of the cap height
 * band agree, which is what the eye reads as level. The figure is measured off
 * the rendered card rather than derived, because how much air a line box has is
 * a property of the renderer as much as of the font. Note that a top margin on
 * a centred flex item moves it by half the margin, since the margin joins the
 * box that is being centred, so this is twice the four pixels it removes.
 * Expressed against the font size, so changing the lockup scale keeps it true.
 */
const CAP_CENTRE_NUDGE = Math.round(0.077 * FONT_SIZE);

export default async function OpenGraphImage() {
  const wordmark = await readFile(join(process.cwd(), "assets/fonts/Baloo2-SemiBold.ttf"));

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
        <div style={{ alignItems: "center", display: "flex", gap: GAP }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={markDataUri(imagePalette.brand)} width={MARK_BOX} height={MARK_BOX} alt="" />
          <div
            style={{
              color: imagePalette.heading,
              display: "flex",
              fontFamily: "Baloo 2",
              fontSize: FONT_SIZE,
              fontWeight: 600,
              marginTop: CAP_CENTRE_NUDGE,
            }}
          >
            OpenLimiter
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: "Baloo 2",
          data: wordmark,
          style: "normal",
          weight: 600,
        },
      ],
    },
  );
}
