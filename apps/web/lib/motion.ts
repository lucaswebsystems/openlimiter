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
 *
 * The numbers, and where they come from.
 *
 * The entrance was tuned against paseo.sh, read from its live bundle rather
 * than guessed at. That site animates opacity 0 to 1 and translateY 20px to 0
 * over 500ms on a plain `ease-out`, triggers on an IntersectionObserver 60
 * pixels inside the viewport, and never replays. Ours is the same shape: 20
 * pixels of travel, the same `cubic-bezier(0, 0, 0.58, 1)` that `ease-out`
 * expands to, 560ms rather than 500 because a group here staggers and the
 * slightly longer arc keeps the last card in the same breath as the first, and
 * the same observer margin and one shot behaviour.
 *
 * The one deliberate departure: paseo hides its start state in the server
 * markup, so a visitor whose JavaScript fails is served a hero with
 * `style="opacity:0"` on it and reads nothing. Everything above exists so that
 * cannot happen here.
 */

/** Set on any element that should fade and rise into view. */
export const REVEAL_ATTR = "data-reveal";

/**
 * The value `data-reveal` takes on a small element that should travel less:
 * a breadcrumb, a chip row, a one line note. Twelve pixels instead of twenty,
 * on the same curve and the same duration, so it still belongs to the group it
 * arrives with.
 */
export const REVEAL_SMALL = "sm";

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

/** The same entrance over a shorter distance. See `REVEAL_SMALL`. */
export const revealSm = { [REVEAL_ATTR]: REVEAL_SMALL } as const;

/**
 * Spread onto a grid or a list whose direct children carry `reveal`, so they
 * arrive one after another instead of all at once.
 */
export const revealGroup = { [REVEAL_GROUP_ATTR]: "" } as const;
