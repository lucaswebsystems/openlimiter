import { Baloo_2 } from "next/font/google";

/**
 * The wordmark face.
 *
 * The approved lockup in assets/brand sets OpenLimiter in Baloo 2 at weight
 * 600, so the site sets it in the same face at the same weight rather than
 * approximating it with whatever the operating system calls its interface font.
 * It is loaded for the wordmark and nothing else: headings and body text still
 * render in the system stack, which is one font file for the entire site.
 *
 * Next self hosts the file at build time, so no request ever leaves the
 * visitor's browser for it, and `display: swap` means the wordmark is readable
 * from the first paint whatever happens to the file.
 */
export const wordmarkFont = Baloo_2({
  subsets: ["latin"],
  weight: ["600"],
  display: "swap",
});
