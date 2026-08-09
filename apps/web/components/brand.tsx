import {
  MARK_DRAW_ATTR,
  MARK_SEGMENTS,
  MARK_SEGMENTS_SMALL,
  MARK_STROKE_WIDTH,
  MARK_STROKE_WIDTH_SMALL,
  MARK_VIEWBOX,
} from "@/lib/brand";
import { wordmarkFont } from "@/lib/fonts";

/**
 * The mark and the lockup.
 *
 * Both are server rendered and ship no JavaScript. The draw in is pure CSS,
 * keyed off the attribute below, so the mark is present in the markup from the
 * first byte and no content ever waits on a script.
 *
 * The mark paints in `currentColor`, and every caller sets that to the brand
 * blue, which is the one colour the identity has. It is the same ring, in the
 * same blue, as the favicon and the files in assets/brand.
 */

export function BrandMark({
  className = "h-6 w-6 text-brand",
  draw = false,
  variant = "full",
}: {
  className?: string;
  /** Let this instance play the one draw in of the session. */
  draw?: boolean;
  /** The four segment telling, for anything rendered below about 48 pixels. */
  variant?: "full" | "small";
}) {
  const drawAttributes = draw ? { [MARK_DRAW_ATTR]: "draw" } : {};
  const segments = variant === "small" ? MARK_SEGMENTS_SMALL : MARK_SEGMENTS;
  const strokeWidth = variant === "small" ? MARK_STROKE_WIDTH_SMALL : MARK_STROKE_WIDTH;

  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={className}
      aria-hidden="true"
      focusable="false"
      {...drawAttributes}
    >
      {segments.map((segment) => (
        <path
          key={segment.d}
          d={segment.d}
          fill="none"
          stroke="currentColor"
          strokeOpacity={segment.opacity}
          strokeWidth={strokeWidth}
          strokeLinecap="butt"
          /* Normalised length, so one dash rule covers every arc. */
          pathLength={1}
        />
      ))}
    </svg>
  );
}

/**
 * Mark plus wordmark, at the proportion the approved lockup in assets/brand
 * uses.
 *
 * The mark carries the brand blue and stands about one and a half times the
 * wordmark's cap size, so it reads as the senior half of the pair rather than a
 * bullet in front of a word. The wordmark is Baloo 2 at weight 600, which is
 * the lockup's own face, in the heading colour.
 */
export function BrandLockup({
  markClassName = "h-8 w-8 flex-none text-brand sm:h-9 sm:w-9",
  wordClassName = "text-xl sm:text-2xl",
  draw = false,
}: {
  markClassName?: string;
  wordClassName?: string;
  draw?: boolean;
}) {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark className={markClassName} draw={draw} />
      <span
        className={`${wordmarkFont.className} font-semibold tracking-tight text-heading ${wordClassName}`}
      >
        OpenLimiter
      </span>
    </span>
  );
}
