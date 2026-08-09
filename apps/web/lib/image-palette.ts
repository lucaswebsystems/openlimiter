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
  canvas: "#0d0d0f",
  /** mirrors --ol-surface, dark */
  surface: "#141416",
  /** mirrors --ol-hairline, dark */
  hairline: "#24242a",
  /** mirrors --ol-heading, dark */
  heading: "#fafafa",
  /** mirrors --ol-soft, dark */
  body: "#b6b6bd",
  /** mirrors --ol-accent-solid, both themes */
  accent: "#0866ff",
  /** mirrors --ol-on-accent, both themes */
  onAccent: "#ffffff",
  /** mirrors --ol-brand. The one blue in assets/brand, unchanged by theme. */
  brand: "#0866ff",
  /** mirrors --ol-canvas, light */
  canvasLight: "#f8f8f9",
} as const;

/**
 * The two icon treatments, and why there are two.
 *
 * `favicon` is the browser tab. It is the ring itself, in the brand blue, on
 * the site's own near black, filling as much of the square as the artwork
 * allows, because at 16 pixels the only thing that can survive is the mark and
 * it has to be recognisably the mark from the header. The background is there
 * only so the ring has a guaranteed ground rather than whatever chrome it lands
 * in.
 *
 * `tile` is a home screen. That is a large icon on somebody's own wallpaper, so
 * it takes the approved tile artwork instead: the ring reversed out of a solid
 * brand blue square, which is exactly assets/brand/openlimiter-tile-1024.png
 * and exactly the PNGs in public/icons, so every home screen surface agrees.
 *
 * `radiusRatio` and `markRatio` are fractions of the icon edge, so one
 * treatment scales to any size without a second set of numbers.
 */
export const favicon = {
  background: imagePalette.canvas,
  mark: imagePalette.brand,
  radiusRatio: 0.22,
  markRatio: 0.86,
} as const;

export const tile = {
  background: imagePalette.brand,
  mark: "#ffffff",
  radiusRatio: 0.22,
  markRatio: 0.68,
} as const;

export type ImagePalette = typeof imagePalette;
export type ImagePaletteToken = keyof ImagePalette;
