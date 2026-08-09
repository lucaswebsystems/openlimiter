/**
 * Palette for the generated image routes (opengraph-image, icon, apple-icon).
 *
 * These routes render in an isolated satori context with no stylesheet, so they
 * cannot read the design tokens in app/globals.css. This module is the single
 * place those literals may live, and every value mirrors a token by name.
 * Change a token in globals.css, change it here in the same pass.
 *
 * A social card has no theme to follow, so these mirror the dark palette, which
 * is the one that reads best as a thumbnail.
 */
export const imagePalette = {
  /** mirrors --ol-canvas, dark */
  canvas: "#101615",
  /** mirrors --ol-surface, dark */
  surface: "#171d1c",
  /** mirrors --ol-hairline, dark */
  hairline: "#272d2c",
  /** mirrors --ol-heading, dark */
  heading: "#fafafa",
  /** mirrors --ol-soft, dark */
  body: "#b4b6b5",
  /** mirrors --ol-accent-solid, dark */
  accent: "#2dd4bf",
  /** mirrors --ol-on-accent, dark */
  onAccent: "#101615",
} as const;

/**
 * The app tile treatment: the mark inverted onto a solid accent rounded square.
 * It is the only place the mark is not painted in the foreground colour, and it
 * exists because a small icon needs a guaranteed background rather than
 * whatever chrome it lands on.
 *
 * `radiusRatio` and `markRatio` are fractions of the tile edge, so one
 * treatment scales from the 32 pixel favicon to the 1024 pixel PNG in
 * assets/brand without a second set of numbers.
 */
export const tile = {
  background: imagePalette.accent,
  mark: imagePalette.onAccent,
  radiusRatio: 0.22,
  markRatio: 0.68,
} as const;

export type ImagePalette = typeof imagePalette;
export type ImagePaletteToken = keyof ImagePalette;
