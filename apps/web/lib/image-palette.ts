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
 * The icon treatment: the ring, and nothing whatsoever behind it.
 *
 * Every icon a browser paints beside a name takes this. The tab favicon, the
 * iOS home screen icon and the two "any" icons in the web application manifest
 * are the mark in the brand blue on a transparent ground, cropped to the ring's
 * own outer edge so it fills its square corner to corner with no padding.
 *
 * There is no tile because a tile is a second shape competing with the mark.
 * At sixteen pixels a rounded blue square with a small ring inside it reads as
 * a rounded blue square, and every pixel spent on padding is a pixel the ring
 * does not have. Tileless, the mark is the icon.
 *
 * Two surfaces deliberately do not take this treatment, and both have a reason
 * that is not taste:
 *
 *   Android maskable, in public/icons, crops to whatever shape the launcher
 *   prefers and guarantees only the central eighty percent. An icon with no
 *   ground would be cropped straight into the wallpaper, so that one file fills
 *   its square with the canvas colour and pulls the ring into the safe area.
 *   scripts/icons.mjs renders it and says the same thing at the point of use.
 *
 *   The desktop application icon keeps a tile, because an operating system
 *   paints it on a dock, a taskbar and a wallpaper it did not choose, and every
 *   application beside it has a solid silhouette. apps/desktop/scripts/icons.mjs
 *   owns that one.
 */
export const iconMark = {
  background: "transparent",
  mark: imagePalette.brand,
} as const;
