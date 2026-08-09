/**
 * Palette for the generated image routes (opengraph-image, icon, apple-icon).
 *
 * These routes render in an isolated satori context with no stylesheet, so they
 * cannot read the design tokens in app/globals.css. This module is the single
 * place those literals may live, and every value mirrors a token by name.
 * Change a token in globals.css, change it here in the same pass.
 */
export const imagePalette = {
  /** mirrors --color-canvas */
  canvas: "#0a0a0b",
  /** mirrors --color-heading */
  heading: "#ededed",
  /** mirrors --color-body */
  body: "#8a8a92",
} as const;

export type ImagePalette = typeof imagePalette;
export type ImagePaletteToken = keyof ImagePalette;
