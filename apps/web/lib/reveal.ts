/**
 * Shared contract for the scroll reveal.
 *
 * The reveal is deliberately CSS driven. Server rendered wrappers carry
 * `data-reveal`, one client controller owns a single IntersectionObserver, and
 * the hidden state only exists while the document is armed. Content is visible
 * by default, so a script that never boots can never leave the page blank.
 */

/** Set on <html> by the inline arming script, before first paint. */
export const REVEAL_ARMED_ATTR = "data-reveal-armed";

/** Set on <html> by the controller to prove it mounted. */
export const REVEAL_LIVE_ATTR = "data-reveal-live";

/** Marks a wrapper as revealed. Styling keys off its absence. */
export const REVEAL_SHOWN_ATTR = "data-reveal-shown";

/** Marks a wrapper as a reveal target. */
export const REVEAL_TARGET_ATTR = "data-reveal";

/** Stagger position. Delays live in globals.css, 50ms per step. */
export const REVEAL_STEP_ATTR = "data-reveal-step";

/** Highest stagger step with a delay defined in globals.css. */
export const REVEAL_MAX_STEP = 7;

/** How long the arming script waits for the controller before standing down. */
export const REVEAL_ARM_TIMEOUT_MS = 1600;

/** How long the controller waits for a first observer callback. */
export const REVEAL_OBSERVER_TIMEOUT_MS = 1200;

/**
 * Runs before the body paints. It arms the hidden state only when the browser
 * can honour it, and disarms again if the controller never reports in.
 */
export const revealArmScript = [
  "(function(){try{",
  'var d=document.documentElement;',
  'if(!("IntersectionObserver" in window))return;',
  'if(window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;',
  `d.setAttribute("${REVEAL_ARMED_ATTR}","1");`,
  "window.setTimeout(function(){",
  `if(!d.hasAttribute("${REVEAL_LIVE_ATTR}")){d.removeAttribute("${REVEAL_ARMED_ATTR}")}`,
  `},${REVEAL_ARM_TIMEOUT_MS})`,
  `}catch(e){document.documentElement.removeAttribute("${REVEAL_ARMED_ATTR}")}})();`,
].join("");
