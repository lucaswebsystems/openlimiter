import { ImageResponse } from "next/og";
import { BRAND_LOCKUP_DARK_DATA_URI } from "@/lib/brand.generated";
import { imagePalette } from "@/lib/image-palette";

/**
 * The social card: the logo, on the brand's own dark canvas, and nothing else.
 *
 * A link pasted into a chat is seen for about as long as it takes to scroll
 * past, so the card carries the one thing worth recognising at that speed. No
 * tagline, no address, no ornament. It is the lockup from assets/brand, in the
 * proportions that file draws it in, at about sixty percent of the card width.
 *
 * The wordmark uses the same system sans and semibold weight as every product
 * surface. The renderer needs no font file and no network request.
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
export default function OpenGraphImage() {
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BRAND_LOCKUP_DARK_DATA_URI} width={900} height={188} alt="OpenLimiter" />
      </div>
    ),
    size,
  );
}
