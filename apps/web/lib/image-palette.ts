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
  canvas: "#0a0a0b",
  /** mirrors --ol-surface, dark */
  surface: "#121214",
  /** mirrors --ol-hairline, dark */
  hairline: "#232327",
  /** mirrors --ol-heading, dark */
  heading: "#f2f2f3",
  /** mirrors --ol-body, dark */
  body: "#adadb6",
  /** mirrors --ol-accent-solid, both themes, and is the one brand blue */
  accent: "#0866ff",
  /** mirrors --ol-on-accent, both themes */
  onAccent: "#ffffff",
} as const;

/**
 * The app tile treatment: the mark inverted to white on a solid brand blue
 * rounded square. It is the only place the mark is not painted in the blue,
 * and it exists because a small icon needs a guaranteed background rather than
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
