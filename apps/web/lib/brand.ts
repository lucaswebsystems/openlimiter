/**
 * Runtime behavior for the frozen OpenLimiter lockup.
 *
 * Artwork lives only in assets/brand/openlimiter-lockup.svg. Generated product
 * data URIs live in brand.generated.ts and never duplicate readable path data.
 */

/** Set on html once the restrained brand reveal has already played. */
export const MARK_DRAWN_ATTR = "data-mark-drawn";

/** Session key that remembers the reveal already happened. */
export const MARK_DRAWN_KEY = "openlimiter-mark-drawn";

/**
 * Runs in head before the body paints. Reduced motion and repeat views receive
 * the complete still lockup immediately.
 */
export const markArmScript = [
  "(function(){try{",
  "var d=document.documentElement;",
  'if(window.matchMedia("(prefers-reduced-motion: reduce)").matches){',
  `d.setAttribute("${MARK_DRAWN_ATTR}","1");return}`,
  `if(window.sessionStorage.getItem("${MARK_DRAWN_KEY}")==="1"){`,
  `d.setAttribute("${MARK_DRAWN_ATTR}","1");return}`,
  `window.sessionStorage.setItem("${MARK_DRAWN_KEY}","1")`,
  "}catch(e){}})();",
].join("");
