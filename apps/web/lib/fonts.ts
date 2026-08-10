import { Baloo_2 } from "next/font/google";

/**
 * The display face, and the one instance of it anywhere in this application.
 *
 * The approved lockup in assets/brand sets OpenLimiter in Baloo 2 at weight
 * 600. The site now sets every heading in the same face at the same weight,
 * and so does the product dashboard. Body text, buttons, chips, links,
 * captions and every number stay in the system stack, so the whole thing is
 * two faces and one downloaded file.
 *
 * It is loaded exactly once, here. The wordmark takes `className`, every
 * heading on the marketing site reaches the same file through the custom
 * property below, and so does app/app/theme.css. A second `Baloo_2({...})`
 * call anywhere would self host the face a second time for no benefit, so
 * there is not one.
 *
 * Next self hosts the file at build time, so no request ever leaves the
 * visitor's browser for it, `subsets` holds it to the Latin range, and
 * `display: swap` means a heading is readable from the first paint whatever
 * happens to the file.
 */
export const wordmarkFont = Baloo_2({
  subsets: ["latin"],
  weight: ["600"],
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
