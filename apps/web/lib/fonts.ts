import localFont from "next/font/local";

/**
 * The display face, and the one instance of it anywhere in this application.
 *
 * The approved lockup in assets/brand sets OpenLimiter in Baloo 2 at weight
 * 600. The site now sets every heading in the same face at the same weight,
 * and so does the product dashboard. Body text, buttons, chips, links,
 * captions and every number stay in the system stack, so the whole thing is
 * two faces and one bundled file.
 *
 * It is loaded exactly once, here. The wordmark takes `className`, every
 * heading on the marketing site reaches the same file through the custom
 * property below, and so does app/app/theme.css. A second font loader call
 * anywhere would bundle the face a second time for no benefit, so there is
 * not one.
 *
 * The repository carries the font file, so neither a build nor a visitor asks
 * Google for it. `display: swap` means a heading is readable from the first
 * paint whatever happens to the file.
 */
export const wordmarkFont = localFont({
  src: "../assets/fonts/Baloo2-SemiBold.ttf",
  weight: "600",
  style: "normal",
  display: "swap",
  /**
   * The same face, reachable from a stylesheet.
   *
   * `className` covers an element the React tree owns. Headings are set from
   * CSS, on both surfaces, where there is no component to hang a class on, so
   * the family is published as a custom property too. The root layout puts
   * this on <html>, which is what makes it resolvable from app/globals.css and
   * from app/app/theme.css alike. Nothing about the wordmark changes: this
   * only adds a second way to name the one font the project loads.
   */
  variable: "--font-brand",
});
