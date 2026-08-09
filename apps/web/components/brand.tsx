import { MARK_DRAW_ATTR, MARK_SEGMENTS, MARK_STROKE_WIDTH, MARK_VIEWBOX } from "@/lib/brand";

/**
 * The mark and the lockup.
 *
 * Both are server rendered and ship no JavaScript. The draw in is pure CSS,
 * keyed off the attribute below, so the mark is present in the markup from the
 * first byte and no content ever waits on a script.
 */

export function BrandMark({
  className = "h-6 w-6",
  draw = false,
}: {
  className?: string;
  /** Let this instance play the one draw in of the session. */
  draw?: boolean;
}) {
  const drawAttributes = draw ? { [MARK_DRAW_ATTR]: "draw" } : {};

  return (
    <svg
      viewBox={MARK_VIEWBOX}
      className={className}
      aria-hidden="true"
      focusable="false"
      {...drawAttributes}
    >
      {MARK_SEGMENTS.map((segment) => (
        <path
          key={segment.d}
          d={segment.d}
          fill="none"
          stroke="currentColor"
          strokeOpacity={segment.opacity}
          strokeWidth={MARK_STROKE_WIDTH}
          strokeLinecap="butt"
          /* Normalised length, so one dash rule covers every arc. */
          pathLength={1}
        />
      ))}
    </svg>
  );
}

/**
 * Mark plus wordmark, both in the heading colour and both in the interface
 * font. There is no separate display face on this site.
 */
export function BrandLockup({
  markClassName = "h-6 w-6 flex-none text-heading",
  wordClassName = "text-lg",
  draw = false,
}: {
  markClassName?: string;
  wordClassName?: string;
  draw?: boolean;
}) {
  return (
    <span className="flex items-center gap-3">
      <BrandMark className={markClassName} draw={draw} />
      <span className={`font-medium text-heading ${wordClassName}`}>OpenLimiter</span>
    </span>
  );
}
