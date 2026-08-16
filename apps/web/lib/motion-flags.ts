/**
 * The motion switches, and the reason there is more than one.
 *
 * `HERO_BACKDROP_ENABLED` in site.ts governs exactly one thing: the media inside
 * the first fold, its poster, its footage, and its pause control. It was written
 * for that and its contract says so. It is NOT a site wide motion kill switch,
 * and an adversarial review of the 3D plan caught the plan assuming it was. A
 * flag that only covers the fold cannot protect a ScrollTrigger sequence four
 * sections down the page.
 *
 * So each motion system carries its own switch here, and each one is typed
 * `boolean` rather than left to infer a literal, so both branches stay type
 * checked and flipping a value can never turn the other one into dead code the
 * compiler has already discarded.
 *
 * NONE OF THESE OVERRIDE THE VISITOR
 * ----------------------------------
 * Every system behind these flags refuses to run under
 * `prefers-reduced-motion: reduce`, refuses under Save Data, and refuses on
 * viewports below the width it was designed for. Those refusals are decided in
 * JavaScript rather than CSS, because CSS can only hide a thing that has already
 * been fetched and started. A flag here turning `true` never outranks any of
 * them: it decides whether a system is allowed to ask, not whether the visitor
 * has to say yes.
 */

/**
 * The WebGL meter field behind the first fold.
 *
 * When this is `false` the canvas module is never imported, so the three.js
 * bundle never enters the graph and the fold keeps its poster and footage
 * exactly as they are today.
 *
 * The poster stays the Largest Contentful Paint element either way. The canvas
 * mounts transparent and fades in OVER the poster only after its first frame has
 * rendered, which is the same arrangement the footage already uses. Nothing here
 * is ever allowed to become the thing the page is waiting to paint.
 */
export const HERO_CANVAS_ENABLED: boolean = true;

/**
 * Scroll choreography below the fold: counters, bar fills, staggered reveals.
 *
 * Separate from the canvas on purpose. The two fail differently and one being
 * wrong is not a reason to lose the other, which is exactly the coupling the
 * review objected to.
 */
export const SCROLL_MOTION_ENABLED: boolean = true;

/**
 * The narrowest viewport the WebGL field is allowed on.
 *
 * A phone gets the twenty kilobyte still, not a shader. This mirrors the width
 * the footage already uses, so the fold has one rule about small screens rather
 * than two that can drift apart.
 */
export const HERO_CANVAS_MIN_WIDTH = 768;
