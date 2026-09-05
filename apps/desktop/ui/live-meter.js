/**
 * The live meter: the one thing this window is for.
 *
 * Everything else here is a list. This is the instrument. It answers two
 * questions at a glance, from across a desk, without being read: how much of
 * the window is gone, and how long until it comes back.
 *
 * The ring carries the first answer and the bar carries it again underneath,
 * because a ring is quick to judge and slow to compare while a bar is the
 * reverse. Together they are the same number said twice in two registers, and
 * the second reading is what stops a person leaning in to check.
 *
 * Three rules govern the motion, and all three are about honesty rather than
 * polish:
 *
 *   The sweep is tweened, so a jump from 42 to 78 is seen happening. A value
 *   that teleports is a value nobody notices moved.
 *
 *   The band colour changes the moment the threshold is crossed and eases over
 *   the crossing rather than snapping, so the eye is pulled to a meter that has
 *   just become someone's problem. The sweep is deliberately slower than the
 *   colour: the bar arrives at its new length just after it has admitted its
 *   new band.
 *
 *   The countdown ticks on the real second boundary, not on a drifting
 *   interval, so two windows opened a minute apart still tick together and
 *   neither shows a second that has already gone.
 *
 * Under prefers-reduced-motion the tween and the pulse stop dead: the ring and
 * the bar jump to the value they are reporting. The countdown keeps ticking,
 * because the time left is information rather than decoration, and it is set
 * in tabular figures so a changing digit never moves the ones beside it.
 *
 * The element decides nothing about quota. It is handed a percentage, a band
 * and a reset instant that packages/core has already decided, and it draws
 * them. Not one threshold is named in this file.
 */

const TAG = "openlimiter-live-meter";

/* A 44 radius ring at a 4 unit stroke sits inside a 100 unit box with room for
   the cap. Circumference is fixed here rather than recomputed per frame. */
const RING_RADIUS = 44;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The tween, long enough to be seen and short enough not to be waited on. */
const SWEEP_MS = 520;

const BAND_LABELS = {
  green: "Normal headroom",
  yellow: "Watch threshold",
  orange: "High utilisation",
  red: "Critical depletion",
  stale: "No live reading",
};

/* cubic-bezier(0.16, 1, 0.3, 1) as a function, so the ring and the CSS around
   it are eased by the same curve rather than by two curves that look alike. */
function easeOutExpo(t) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function prefersReducedMotion() {
  if (typeof globalThis.matchMedia !== "function") return false;
  return globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The countdown, in the shape the design contract writes it: `03h 48m 12s`.
 *
 * A window more than a day out drops the seconds, because a person reading
 * "2d 06h" is not counting and a ticking second there is only noise.
 */
export function countdownText(resetAt, now) {
  if (resetAt === null || resetAt === undefined) return null;
  const target = typeof resetAt === "number" ? resetAt : Date.parse(resetAt);
  if (!Number.isFinite(target)) return null;
  const remaining = target - now;
  if (remaining <= 0) return "Resetting";
  if (remaining >= DAY) {
    const days = Math.floor(remaining / DAY);
    const hours = Math.floor((remaining % DAY) / HOUR);
    return String(days) + "d " + String(hours).padStart(2, "0") + "h";
  }
  const hours = Math.floor(remaining / HOUR);
  const minutes = Math.floor((remaining % HOUR) / MINUTE);
  const seconds = Math.floor((remaining % MINUTE) / SECOND);
  return (
    String(hours).padStart(2, "0") +
    "h " +
    String(minutes).padStart(2, "0") +
    "m " +
    String(seconds).padStart(2, "0") +
    "s"
  );
}

const STYLE = `
:host {
  display: block;
  min-width: 0;
  container-type: inline-size;
  font-family: var(--ol-font-sans);
  --live-fill: var(--ol-band-stale-fill);
  --live-label: var(--ol-band-stale-label);
  --live-subtle: var(--ol-band-stale-subtle);
}
:host([data-band="green"]) {
  --live-fill: var(--ol-band-green-fill);
  --live-label: var(--ol-band-green-label);
  --live-subtle: var(--ol-band-green-subtle);
}
:host([data-band="yellow"]) {
  --live-fill: var(--ol-band-yellow-fill);
  --live-label: var(--ol-band-yellow-label);
  --live-subtle: var(--ol-band-yellow-subtle);
}
:host([data-band="orange"]) {
  --live-fill: var(--ol-band-orange-fill);
  --live-label: var(--ol-band-orange-label);
  --live-subtle: var(--ol-band-orange-subtle);
}
:host([data-band="red"]) {
  --live-fill: var(--ol-band-red-fill);
  --live-label: var(--ol-band-red-label);
  --live-subtle: var(--ol-band-red-subtle);
}
* { box-sizing: border-box; }

.instrument {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--ol-space-5);
  padding: var(--ol-space-5);
  border: 1px solid var(--ol-hairline);
  border-radius: var(--ol-radius-sm);
  background: var(--ol-surface);
  box-shadow: inset 0 1px 0 0 var(--sheen);
  /* The one place a band tint touches a surface: a hairline of the band along
     the leading edge, so a critical card is identifiable with the numbers
     covered up. */
  border-left: 2px solid var(--live-fill);
  transition: border-color var(--ol-motion-fast) var(--ol-ease-out);
}

.dial {
  position: relative;
  width: 6.5rem;
  height: 6.5rem;
  flex: none;
}
.dial svg {
  width: 100%;
  height: 100%;
  display: block;
  /* Twelve o'clock, clockwise. A gauge that starts at three reads as a chart. */
  transform: rotate(-90deg);
}
.ring-track {
  fill: none;
  stroke: var(--ol-track);
  stroke-width: 8;
}
.ring-sweep {
  fill: none;
  stroke: var(--live-fill);
  stroke-width: 8;
  stroke-linecap: round;
  transition: stroke var(--ol-motion-fast) var(--ol-ease-out);
}
:host([data-band="stale"]) .ring-sweep { stroke: var(--ol-band-stale-fill); }

.dial-face {
  position: absolute;
  inset: 0;
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 2px;
}
.dial-value {
  color: var(--live-label);
  font-family: var(--ol-font-mono);
  font-size: 1.5rem;
  font-variant-numeric: tabular-nums;
  font-weight: var(--ol-weight-semibold);
  line-height: 1;
  transition: color var(--ol-motion-fast) var(--ol-ease-out);
}
.dial-unit {
  color: var(--ol-muted);
  font-size: var(--ol-text-micro);
  font-weight: var(--ol-weight-semibold);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.readout { min-width: 0; display: grid; gap: var(--ol-space-2); }
.headline {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ol-space-2);
}
.window-name {
  min-width: 0;
  overflow: hidden;
  color: var(--ol-heading);
  font-size: var(--ol-text-label);
  font-weight: var(--ol-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account {
  color: var(--ol-muted);
  font-size: var(--ol-text-caption);
  white-space: nowrap;
}

/* The live pip. Presence means a stream is arriving; absence means the last
   reading is all there is. It is never the only thing saying so. */
.pip {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: var(--ol-radius-pill);
  background: var(--live-fill);
  box-shadow: 0 0 0 0 var(--live-subtle);
  animation: pulse 2000ms var(--ol-ease-out) infinite;
}
:host([data-live="false"]) .pip {
  background: var(--ol-band-stale-fill);
  animation: none;
}
@keyframes pulse {
  0% { transform: scale(1); box-shadow: 0 0 0 0 var(--live-subtle); }
  60% { transform: scale(1.15); box-shadow: 0 0 0 5px transparent; }
  100% { transform: scale(1); box-shadow: 0 0 0 0 transparent; }
}

.bar {
  position: relative;
  height: 0.625rem;
  overflow: hidden;
  border-radius: var(--ol-radius-pill);
  background: var(--ol-track);
}
.bar-fill {
  display: block;
  height: 100%;
  width: 0;
  border-radius: inherit;
  background: var(--live-fill);
  transition: background-color var(--ol-motion-fast) var(--ol-ease-out);
}
:host([data-band="stale"]) .bar { background: var(--ol-band-hatched-pattern); }
:host([data-band="stale"]) .bar-fill { background: transparent; }

.foot {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ol-space-1) var(--ol-space-3);
}
.headroom {
  color: var(--ol-muted);
  font-size: var(--ol-text-caption);
}
.reset {
  display: inline-flex;
  align-items: baseline;
  gap: var(--ol-space-2);
  color: var(--ol-soft);
  font-size: var(--ol-text-caption);
  white-space: nowrap;
}
.reset-clock {
  color: var(--ol-heading);
  font-family: var(--ol-font-mono);
  font-variant-numeric: tabular-nums;
  /* The clock is the one value that changes every second. A fixed advance
     keeps the colon from walking as the digits underneath it change. */
  letter-spacing: 0.01em;
}
.band-name {
  color: var(--live-label);
  font-size: var(--ol-text-micro);
  font-weight: var(--ol-weight-semibold);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  transition: color var(--ol-motion-fast) var(--ol-ease-out);
}

/* Under the compact minimum window the dial stacks above the readout rather
   than shrinking to a size where the percentage stops being legible. */
@container (max-width: 22rem) {
  .instrument {
    grid-template-columns: minmax(0, 1fr);
    justify-items: start;
    gap: var(--ol-space-4);
    padding: var(--ol-space-4);
  }
  .dial { width: 5rem; height: 5rem; }
  .dial-value { font-size: 1.125rem; }
  .readout { width: 100%; }
}

@media (prefers-reduced-motion: reduce) {
  .pip { animation: none; }
  .ring-sweep,
  .bar-fill,
  .dial-value,
  .band-name,
  .instrument { transition: none; }
}
`;

function template() {
  return (
    '<section class="instrument" part="instrument">' +
    '<div class="dial">' +
    '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
    '<circle class="ring-track" cx="50" cy="50" r="' +
    String(RING_RADIUS) +
    '"></circle>' +
    '<circle class="ring-sweep" cx="50" cy="50" r="' +
    String(RING_RADIUS) +
    '" stroke-dasharray="' +
    String(RING_CIRCUMFERENCE) +
    '" stroke-dashoffset="' +
    String(RING_CIRCUMFERENCE) +
    '"></circle>' +
    "</svg>" +
    '<div class="dial-face"><span class="dial-value">0</span>' +
    '<span class="dial-unit">used</span></div>' +
    "</div>" +
    '<div class="readout">' +
    '<div class="headline"><span class="pip" aria-hidden="true"></span>' +
    '<span class="window-name"></span><span class="account"></span></div>' +
    /* Named and described before any data arrives. A progressbar that exists
       with no name is one a screen reader announces as an anonymous slider,
       and the instrument is built in the document before it is ever fed. */
    '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" ' +
    'aria-label="Quota window usage" aria-valuetext="No reading yet">' +
    '<span class="bar-fill"></span></div>' +
    '<div class="foot"><span class="headroom"></span>' +
    '<span class="reset"><span class="band-name"></span>' +
    '<span class="reset-clock"></span></span></div>' +
    "</div></section>"
  );
}

export class OpenLimiterLiveMeter extends HTMLElement {
  #root;
  #nodes = null;
  #target = 0;
  #drawn = 0;
  #from = 0;
  #startedAt = 0;
  #frame = 0;
  #tick = 0;
  #resetAt = null;
  #view = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
    this.#root.innerHTML = "<style>" + STYLE + "</style>" + template();
    const q = (selector) => this.#root.querySelector(selector);
    this.#nodes = {
      sweep: q(".ring-sweep"),
      value: q(".dial-value"),
      name: q(".window-name"),
      account: q(".account"),
      bar: q(".bar"),
      fill: q(".bar-fill"),
      headroom: q(".headroom"),
      clock: q(".reset-clock"),
      band: q(".band-name"),
    };
  }

  connectedCallback() {
    if (!this.hasAttribute("role")) this.setAttribute("role", "group");
    this.#startTicking();
  }

  disconnectedCallback() {
    this.#stop();
  }

  /**
   * The one input. Everything below draws it; nothing below decides it.
   *
   *   { windowName, accountLabel, usedPercent, band, live, resetAt }
   */
  set meter(view) {
    this.#view = view;
    const nodes = this.#nodes;
    const band = view.band ?? "stale";
    const used = view.usedPercent === null ? null : clampPercent(view.usedPercent);

    this.dataset.band = band;
    this.dataset.live = String(view.live === true);
    nodes.name.textContent = view.windowName ?? "";
    nodes.account.textContent = view.accountLabel ?? "";
    nodes.band.textContent = BAND_LABELS[band] ?? "";
    this.#resetAt = view.resetAt ?? null;

    if (used === null) {
      nodes.headroom.textContent = "No reading to report";
      nodes.value.textContent = "--";
      nodes.bar.setAttribute("aria-valuetext", "No reliable reading");
      nodes.bar.removeAttribute("aria-valuenow");
      this.#sweepTo(0);
    } else {
      const headroom = Math.max(0, 100 - used);
      nodes.headroom.textContent =
        headroom === 0
          ? "No headroom left"
          : headroom.toFixed(0) + "% headroom left";
      nodes.bar.setAttribute("aria-valuenow", String(Math.round(used)));
      nodes.bar.setAttribute(
        "aria-valuetext",
        used.toFixed(0) + "% used, " + (BAND_LABELS[band] ?? "")
      );
      this.#sweepTo(used);
    }

    nodes.bar.setAttribute(
      "aria-label",
      (view.windowName ?? "Quota window") + " usage"
    );
    this.#paintClock();
  }

  get meter() {
    return this.#view;
  }

  /** Tween the ring and the bar to a new value, or jump when motion is off. */
  #sweepTo(next) {
    this.#target = next;
    if (prefersReducedMotion()) {
      this.#drawn = next;
      this.#paint(next);
      return;
    }
    this.#from = this.#drawn;
    this.#startedAt = 0;
    if (this.#frame !== 0) return;
    const step = (stamp) => {
      if (this.#startedAt === 0) this.#startedAt = stamp;
      const elapsed = stamp - this.#startedAt;
      const progress = Math.min(1, elapsed / SWEEP_MS);
      const eased = easeOutExpo(progress);
      this.#drawn = this.#from + (this.#target - this.#from) * eased;
      this.#paint(this.#drawn);
      if (progress < 1) {
        this.#frame = requestAnimationFrame(step);
        return;
      }
      this.#frame = 0;
      this.#drawn = this.#target;
      this.#paint(this.#target);
    };
    this.#frame = requestAnimationFrame(step);
  }

  /* Direct DOM writes inside the frame. No state round trip per frame. */
  #paint(value) {
    const nodes = this.#nodes;
    const fraction = clampPercent(value) / 100;
    nodes.sweep.setAttribute(
      "stroke-dashoffset",
      String(RING_CIRCUMFERENCE * (1 - fraction))
    );
    nodes.fill.style.width = String(clampPercent(value)) + "%";
    if (this.#view !== null && this.#view.usedPercent !== null) {
      nodes.value.textContent = Math.round(value).toFixed(0);
    }
  }

  /**
   * One second, on the second.
   *
   * The first wait is only as long as the remainder of the current second, so
   * the clock lands on the boundary and every open window agrees. After that
   * each tick schedules the next from the wall clock rather than from itself,
   * which is what keeps a throttled background tab from drifting.
   */
  #startTicking() {
    this.#stopTicking();
    const schedule = () => {
      const delay = SECOND - (Date.now() % SECOND);
      this.#tick = setTimeout(() => {
        this.#paintClock();
        schedule();
      }, delay);
    };
    this.#paintClock();
    schedule();
  }

  #paintClock() {
    if (this.#nodes === null) return;
    const text = countdownText(this.#resetAt, Date.now());
    this.#nodes.clock.textContent = text === null ? "No reset published" : text;
  }

  #stopTicking() {
    if (this.#tick !== 0) {
      clearTimeout(this.#tick);
      this.#tick = 0;
    }
  }

  #stop() {
    this.#stopTicking();
    if (this.#frame !== 0) {
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
  }
}

export function defineLiveMeter() {
  if (typeof customElements === "undefined") return;
  if (customElements.get(TAG) !== undefined) return;
  customElements.define(TAG, OpenLimiterLiveMeter);
}

export const LIVE_METER_TAG = TAG;
