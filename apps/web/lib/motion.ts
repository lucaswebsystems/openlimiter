/**
 * The site's motion system, in one file.
 *
 * Sections and cards fade and rise as they come into view, staggered inside a
 * group. The whole thing is one shared IntersectionObserver and three CSS
 * declarations. Exactly one client component exists for it, `<Reveal />` in the
 * root layout, which owns that single observer; no section, card or heading
 * hydrates.
 *
 * The rule that governs every line below: **content is visible by default**.
 * The hidden start state lives behind `:root[data-motion]`, and that attribute
 * is only ever added by the arming script here, after it has confirmed that
 * JavaScript runs at all, that IntersectionObserver exists, and that the
 * visitor has not asked for less motion. No script, an old browser, a thrown
 * error, a blocked inline script or a reduced motion preference all leave the
 * page exactly as the server sent it: painted, readable, complete.
 *
 * There are then two failsafes on top of that, because a reveal that never
 * fires is the one bug this feature can ship:
 *
 *   1. The arming script sets the attribute to `ready` and starts a four
 *      second timer. The observer, once installed, upgrades the value to `on`.
 *      If the timer finds the value still at `ready`, the observer never
 *      arrived, the attribute is removed and the whole page shows.
 *   2. Four seconds after the observer is installed, if not one element has
 *      been reported visible, the observer is treated as broken, the attribute
 *      is removed and the whole page shows.
 *
 * The two step handover exists for a second reason as well. The observer marks
 * elements by setting an attribute on them, and doing that before React
 * hydrates is a hydration mismatch, so the observer waits for the mount of the
 * one client component while the hidden start state is armed before first paint
 * by the inline script. Nothing flashes, and nothing mismatches.
 *
 * Only opacity and a transform ever change, so nothing here can move the
 * layout by a pixel.
 */

/** Set on any element that should fade and rise into view. */
export const REVEAL_ATTR = "data-reveal";

/** Set by the observer on an element that has been seen. */
export const REVEALED_ATTR = "data-revealed";

/** Set on a container whose direct children should stagger. */
export const REVEAL_GROUP_ATTR = "data-reveal-group";

/** Set on <html> only while the hidden start state is safe to apply. */
export const MOTION_ATTR = "data-motion";

/** Armed by the inline script, before the observer exists. */
export const MOTION_ARMED = "ready";

/** Upgraded by the observer once it is actually watching. */
export const MOTION_LIVE = "on";

/** How long either failsafe waits before handing the page back, in ms. */
export const MOTION_FAILSAFE_MS = 4000;

/**
 * Runs in <head>, before the body paints, so an armed page never flashes its
 * content in and then hides it again.
 */
export const motionArmScript = [
  "(function(){var d=document.documentElement;",
  `function off(){try{d.removeAttribute("${MOTION_ATTR}")}catch(e){}}`,
  "try{",
  'if(!("IntersectionObserver" in window)){return}',
  'if(window.matchMedia("(prefers-reduced-motion: reduce)").matches){return}',
  `d.setAttribute("${MOTION_ATTR}","${MOTION_ARMED}");`,
  "window.setTimeout(function(){",
  `if(d.getAttribute("${MOTION_ATTR}")==="${MOTION_ARMED}"){off()}`,
  `},${MOTION_FAILSAFE_MS});`,
  "}catch(e){off()}})();",
].join("");

/**
 * Spread onto anything that should fade and rise into view.
 *
 *   <section {...reveal}>
 */
export const reveal = { [REVEAL_ATTR]: "" } as const;

/**
 * Spread onto a grid or a list whose direct children carry `reveal`, so they
 * arrive one after another instead of all at once.
 */
export const revealGroup = { [REVEAL_GROUP_ATTR]: "" } as const;
