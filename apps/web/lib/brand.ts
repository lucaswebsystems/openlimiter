/**
 * The OpenLimiter mark.
 *
 * A tapering segmented ring. Eight arcs sit on one radius of 72 inside a 200
 * unit box. The first sweeps a quarter of the circle and every next one sweeps
 * 0.7172 of the one before it, with equal eight degree gaps that close the
 * circle exactly. The stroke is 34 units with flat butt caps. There is one
 * blue in the whole system and the only variation between segments is alpha,
 * which fades from 1 down to 0.25 as the segments shrink.
 *
 * The path data below is the approved artwork copied verbatim, so the header
 * lockup, the icon routes, and the files in assets/brand are all the same
 * shape. Nothing here derives a second colour: the segments paint in
 * `currentColor` and the caller decides whether that is the brand blue on a
 * light surface or white on a blue tile.
 */

/** Segments in draw order, largest first. Alpha falls as the arc shrinks. */
export const MARK_SEGMENTS = [
  { d: "M 100.000 28.000 A 72 72 0 0 1 172.000 100.000", opacity: 1 },
  { d: "M 171.299 110.020 A 72 72 0 0 1 121.589 168.687", opacity: 0.893 },
  { d: "M 111.819 171.023 A 72 72 0 0 1 56.819 157.614", opacity: 0.786 },
  { d: "M 49.221 151.044 A 72 72 0 0 1 29.558 114.898", opacity: 0.679 },
  { d: "M 28.170 104.949 A 72 72 0 0 1 32.289 75.521", opacity: 0.571 },
  { d: "M 36.355 66.336 A 72 72 0 0 1 49.052 49.125", opacity: 0.464 },
  { d: "M 56.628 42.529 A 72 72 0 0 1 69.813 34.634", opacity: 0.357 },
  { d: "M 79.204 31.069 A 72 72 0 0 1 89.980 28.701", opacity: 0.25 },
] as const;

/**
 * The same ring, resolved for small sizes.
 *
 * Eight arcs separated by eight degree gaps turn to mush once the whole mark is
 * 16 pixels across: at that size a gap is a fifth of a pixel. This variant is
 * the identical construction with four segments instead of eight, a first sweep
 * of 140 degrees, 14 degree gaps and a heavier stroke, solved by the same
 * geometry so it closes the circle exactly and sits on the same radius. It is
 * the same shape and the same colour, simply told with fewer words, and it is
 * used only where the artwork is rendered below roughly 48 pixels.
 */
export const MARK_SEGMENTS_SMALL = [
  { d: "M 100.000 28.000 A 72 72 0 0 1 146.281 155.155", opacity: 1 },
  { d: "M 131.563 164.713 A 72 72 0 0 1 39.071 138.362", opacity: 0.8 },
  { d: "M 31.600 122.483 A 72 72 0 0 1 38.921 61.877", opacity: 0.6 },
  { d: "M 49.958 48.233 A 72 72 0 0 1 82.582 30.139", opacity: 0.4 },
] as const;

/** The artwork box. Every consumer scales this, none of them redraws it. */
export const MARK_VIEWBOX = "0 0 200 200";

/** Centre of the artwork box, which is also the centre of the ring. */
export const MARK_CENTRE = 100;

/** Radius of the arc centreline, in artwork units. */
export const MARK_RADIUS = 72;

/** Stroke weight in artwork units. */
export const MARK_STROKE_WIDTH = 34;

/** Stroke weight for the four segment variant, heavier so it holds at 16px. */
export const MARK_STROKE_WIDTH_SMALL = 44;

/** Number of segments, so the stagger scale in globals.css can be checked. */
export const MARK_SEGMENT_COUNT = MARK_SEGMENTS.length;

/** Set on the mark element that is allowed to draw itself in. */
export const MARK_DRAW_ATTR = "data-brand-mark";

/** Set on <html> once the draw has already played, or must not play at all. */
export const MARK_DRAWN_ATTR = "data-mark-drawn";

/** Session key that remembers the draw already happened. */
export const MARK_DRAWN_KEY = "openlimiter-mark-drawn";

/** Which telling of the ring a consumer wants. See MARK_SEGMENTS_SMALL. */
export type MarkVariant = "full" | "small";

/**
 * How much room the ring is given inside the box it is drawn into.
 *
 * `box` keeps the 200 unit artwork box, so the ring sits in the padding the
 * artwork was designed with, and a caller placing the mark beside type gets the
 * lockup's own spacing for free.
 *
 * `ring` crops the box to the ring's own outer edge, so the artwork ends where
 * the ink ends and the ring fills whatever square it is given, corner to
 * corner. This is what an icon wants: at sixteen pixels every pixel of built in
 * padding is a pixel the mark does not have.
 */
export type MarkFit = "box" | "ring";

/** Stroke weight of a variant, in artwork units. */
function strokeWidth(variant: MarkVariant): number {
  return variant === "small" ? MARK_STROKE_WIDTH_SMALL : MARK_STROKE_WIDTH;
}

/**
 * The box to draw a variant in. For `ring`, that is the square the stroke's
 * outer edge inscribes: the centreline radius plus half the stroke, taken from
 * the centre in all four directions.
 */
export function markViewBox(variant: MarkVariant = "full", fit: MarkFit = "box"): string {
  if (fit === "box") return MARK_VIEWBOX;
  const outer = MARK_RADIUS + strokeWidth(variant) / 2;
  return `${MARK_CENTRE - outer} ${MARK_CENTRE - outer} ${outer * 2} ${outer * 2}`;
}

/**
 * Standalone markup for contexts with no stylesheet, which is every generated
 * image route. The colour has to be passed in because `currentColor` has
 * nothing to inherit from there.
 */
export function markSvgMarkup(
  color: string,
  variant: MarkVariant = "full",
  fit: MarkFit = "box",
): string {
  const segments = variant === "small" ? MARK_SEGMENTS_SMALL : MARK_SEGMENTS;
  const width = strokeWidth(variant);
  const paths = segments
    .map(
      (segment) =>
        `<path d="${segment.d}" fill="none" stroke="${color}" stroke-opacity="${segment.opacity}"` +
        ` stroke-width="${width}" stroke-linecap="butt"/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${markViewBox(variant, fit)}">${paths}</svg>`;
}

/**
 * The same markup as a data URI, which is how satori accepts vector artwork in
 * the icon and social card routes.
 */
export function markDataUri(
  color: string,
  variant: MarkVariant = "full",
  fit: MarkFit = "box",
): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(markSvgMarkup(color, variant, fit))}`;
}

/**
 * Runs in <head>, before the body paints.
 *
 * The mark draws itself in once per session. This script decides, ahead of the
 * first frame, whether this load is that once. It only ever adds an attribute
 * that turns the animation off, so a browser that blocks it, or a throw of any
 * kind, leaves the pure CSS draw in place rather than hiding anything.
 */
export const markArmScript = [
  "(function(){try{",
  "var d=document.documentElement;",
  'if(window.matchMedia("(prefers-reduced-motion: reduce)").matches){',
  `d.setAttribute("${MARK_DRAWN_ATTR}","1");return}`,
  `if(window.sessionStorage.getItem("${MARK_DRAWN_KEY}")==="1"){`,
  `d.setAttribute("${MARK_DRAWN_ATTR}","1");return}`,
  `window.sessionStorage.setItem("${MARK_DRAWN_KEY}","1")`,
  "}catch(e){}})();",
].join("");
