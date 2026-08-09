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
  /** mirrors --ol-accent-solid, both themes */
  accent: "#0866ff",
  /** mirrors --ol-on-accent, both themes */
  onAccent: "#ffffff",
} as const;

export type ImagePalette = typeof imagePalette;
export type ImagePaletteToken = keyof ImagePalette;
