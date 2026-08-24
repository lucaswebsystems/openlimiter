/**
 * Palette for the generated image routes (opengraph-image, icon, apple-icon).
 *
 * These routes render in an isolated satori context with no stylesheet, so they
 * cannot read the design tokens in app/globals.css. This module is the single
 * place those literals may live, and every value mirrors a token by name.
 * Change a token in packages/ui/src/tokens.css, change it here in the same
 * pass.
 *
 * A social card has no theme to follow, so these mirror the dark palette, which
 * is the one that reads best as a thumbnail.
 */
export const imagePalette = {
  /** mirrors --ol-canvas, dark */
  canvas: "#080b10",
  /** mirrors --ol-surface, dark */
  surface: "#0e131b",
  /** mirrors --ol-hairline, dark */
  hairline: "#202b3a",
  /** mirrors --ol-heading, dark */
  heading: "#fafafa",
  /** mirrors --ol-soft, dark */
  body: "#c3ccd8",
  /** mirrors --ol-accent-solid, both themes */
  accent: "#2f81f7",
  /** mirrors --ol-on-accent, both themes */
  onAccent: "#ffffff",
  /** mirrors --ol-brand. The one blue in assets/brand, unchanged by theme. */
  brand: "#2f81f7",
  /** mirrors --ol-canvas, light */
  canvasLight: "#f4f7fb",
} as const;

/**
 * The icon treatment: the frozen mark, and nothing whatsoever behind it.
 *
 * Every icon a browser paints beside a name takes this. The tab favicon, the
 * iOS home screen icon and the two "any" icons in the web application manifest
 * are the mark in the brand blue on a transparent ground, cropped to the mark's
 * own outer edge so it fills its square corner to corner with no padding.
 *
 * There is no tile because a tile is a second shape competing with the mark.
 * At sixteen pixels a rounded blue square with a small mark inside it reads as
 * a rounded blue square, and every pixel spent on padding is a pixel the mark
 * does not have. Tileless, the mark is the icon.
 *
 * Two surfaces deliberately do not take this treatment, and both have a reason
 * that is not taste:
 *
 *   Android maskable, in public/icons, crops to whatever shape the launcher
 *   prefers and guarantees only the central eighty percent. An icon with no
 *   ground would be cropped straight into the wallpaper, so that one file fills
 *   its square with the canvas colour and pulls the mark into the safe area.
 *   scripts/icons.mjs renders it and says the same thing at the point of use.
 *
 *   The desktop icon remains transparent. The Tauri icon pipeline receives the
 *   canonical SVG directly and generates every package size from it.
 */
export const iconMark = {
  background: "transparent",
  mark: imagePalette.brand,
} as const;
