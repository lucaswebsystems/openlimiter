/**
 * The OpenLimiter window.
 *
 * It reads the same snapshot cache the command line tool writes, runs it
 * through the same engine the command line tool runs, and renders the result.
 * Every rule applied here, what a valid meter is, when a reading goes stale,
 * which provider is under the most pressure, what an agent would be told,
 * comes out of packages/core, packages/connectors and packages/adapters as
 * compiled. Nothing about quota is decided in this file.
 *
 * What this file does decide is how a decided number is drawn: which of the
 * three pressure bands a percentage falls in, how many of the ten blocks that
 * lights, and which English sentence an enum code is shown as. Those three
 * answers are the same ones apps/web/app/app/language.ts gives, so the window
 * and the browser dashboard cannot describe one reading differently.
 *
 * Rust does three things this file cannot: it finds the state directory, it
 * reads two files out of it, and it talks to the system tray. Nothing else
 * crosses the boundary, and nothing at all leaves the machine.
 */
import {
  PROVIDER_CODES,
  buildAdvice,
  dedupeFailures,
  failureSentence,
  floorFixed,
  freshness,
  mergeSnapshots,
  normalizeMetersReport,
} from "./engine/core/index.js";
import { parseManualPayload } from "./engine/connectors/manual.js";
import {
  buildAgentContext,
  renderClaudeStatusline,
} from "./engine/adapters/claude-code.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

/** How often the window re reads the cache, in milliseconds. */
const REFRESH_INTERVAL = 30_000;

/** The event the tray sends when its Refresh item is chosen. */
const REFRESH_EVENT = "openlimiter://refresh";

const PROVIDER_NAMES = {
  CLAUDE: "Claude",
  OPENROUTER: "OpenRouter",
  CODEX: "Codex",
  ANTIGRAVITY: "Antigravity",
  OPENCODE: "OpenCode",
  MANUAL: "Manual",
};

/** What each provider's meters are read from, in four or five words. */
const PROVIDER_ORIGIN = {
  CLAUDE: "Statusline payload",
  OPENROUTER: "Documented credits API",
  CODEX: "Provider managed payload",
  ANTIGRAVITY: "Provider managed payload",
  OPENCODE: "Authenticated page",
  MANUAL: "Written down by you",
};

/** The meters each provider reports, used to draw a card that has no data. */
const EXPECTED_METERS = {
  CLAUDE: ["FIVE_HOUR", "SEVEN_DAY"],
  OPENROUTER: ["CREDITS"],
  CODEX: ["PRIMARY"],
  ANTIGRAVITY: ["PRIMARY"],
  OPENCODE: ["PRIMARY"],
  MANUAL: ["MONTHLY"],
};

/**
 * A meter code, in the words a person uses for that stretch of time.
 *
 * The same table apps/web/app/app/language.ts carries, for the same reason:
 * FIVE_HOUR is the right name in a payload and the wrong one on a card. A code
 * nobody here has heard of, which a manual document is free to invent, is
 * title cased rather than dropped or left shouting.
 */
const METER_NAMES = {
  FIVE_HOUR: "Current session",
  SESSION: "Current session",
  PRIMARY: "Primary window",
  SECONDARY: "Secondary window",
  HOURLY: "Hourly",
  DAILY: "Daily",
  ONE_DAY: "Daily",
  SEVEN_DAY: "Weekly",
  WEEKLY: "Weekly",
  THIRTY_DAY: "Monthly",
  MONTHLY: "Monthly",
  CREDITS: "Credits",
  BALANCE: "Credits",
};

/** Shortest window first, money last, which is the order somebody checks. */
const METER_RANK = {
  FIVE_HOUR: 10,
  SESSION: 10,
  PRIMARY: 15,
  SECONDARY: 16,
  HOURLY: 20,
  DAILY: 30,
  ONE_DAY: 30,
  SEVEN_DAY: 40,
  WEEKLY: 40,
  THIRTY_DAY: 50,
  MONTHLY: 50,
  CREDITS: 60,
  BALANCE: 60,
};

function meterName(code) {
  const known = METER_NAMES[code];
  if (known !== undefined) return known;
  const words = String(code)
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return code;
  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** Unmapped codes sort after every known one, then alphabetically. */
function byMeterOrder(left, right) {
  const difference = (METER_RANK[left] ?? 90) - (METER_RANK[right] ?? 90);
  return difference !== 0 ? difference : String(left).localeCompare(String(right));
}

/** What a freshness state is called on a card. */
const FRESHNESS_WORD = {
  fresh: "Fresh",
  stale: "Stale",
  unknown: "Unknown",
};

/** Where the theme choice is kept, matching the key the site's toggle uses. */
const THEME_KEY = "openlimiter-theme";

/*
 * The provider marks.
 *
 * Real brand artwork, not geometric stand ins. The path data is reproduced
 * from Simple Icons (https://simpleicons.org), whose icon set is published
 * under CC0 1.0 and whose source is MIT licensed, mirrored verbatim from
 * apps/web/components/tool-marks.tsx so the window and the website draw the
 * same glyph. Nothing is hotlinked and nothing is fetched: the paths ship in
 * this bundle, at 24 units, filled with currentColor, so each one follows the
 * theme like any other piece of type.
 *
 * Simple Icons ships no OpenAI mark, so Codex takes a lettered tile drawn
 * here, exactly as the site's InitialMark does. Manual entry is not a company
 * at all and keeps its own glyph: a person writing a number down.
 *
 * These strings are constants. Nothing read off disk ever reaches innerHTML.
 */
const FILLED_OPEN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">';

const STROKED_OPEN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

/** The lettered tile, for a tool with no published mark. */
function initialsMark(initials) {
  return (
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">' +
    '<rect x="1.6" y="1.6" width="20.8" height="20.8" rx="5.6" fill="none" stroke="currentColor" stroke-width="1.7"/>' +
    '<text x="12" y="12.6" text-anchor="middle" dominant-baseline="middle" fill="currentColor" ' +
    'font-size="9.5" font-weight="600" letter-spacing="-0.3" font-family="inherit">' +
    initials +
    "</text></svg>"
  );
}

const MARKS = {
  CLAUDE: FILLED_OPEN + '<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  OPENROUTER: FILLED_OPEN + '<path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"/></svg>',
  OPENCODE: FILLED_OPEN + '<path d="M22 24H2V0h20zM17 4.8H7v14.4h10z"/></svg>',
  /* Antigravity is Google's, and takes the Google mark the catalogue gives it. */
  ANTIGRAVITY: FILLED_OPEN + '<path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
  CODEX: initialsMark("OA"),
  MANUAL:
    STROKED_OPEN +
    '<path d="M16.6 3.6a2 2 0 0 1 2.8 2.8L8.5 17.3l-3.7.9.9-3.7Z"/>' +
    '<path d="m14.6 5.6 3.8 3.8M4 21h16"/></svg>',
};

const CLOCK_GLYPH =
  '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">' +
  '<circle cx="6" cy="6" r="4.6"/><path d="M6 3.4V6l1.9 1.2"/></svg>';

const REASON_SENTENCE = {
  HEALTHY: "Every readable meter is under 80 percent.",
  NEAR_CAP: "At least one readable meter is at 80 percent or more.",
  AT_CAP: "At least one readable meter has reached its cap.",
  UNKNOWN: "Nothing readable has been found yet.",
};

const REASON_PRESSURE = {
  HEALTHY: "ok",
  NEAR_CAP: "high",
  AT_CAP: "critical",
  UNKNOWN: "none",
};

const NO_RECOMMENDATION_SENTENCE = {
  NO_KNOWN_PROVIDER: "No provider has a readable meter.",
  NO_FRESH_DATA: "Every reading has aged past its own expiry.",
  NO_HEALTHY_PROVIDER: "Every readable provider is at 80 percent or more.",
};

const elements = {
  cards: document.getElementById("cards"),
  list: document.getElementById("list"),
  viewGrid: document.getElementById("view-grid"),
  viewList: document.getElementById("view-list"),
  empty: document.getElementById("empty"),
  context: document.getElementById("context"),
  statusline: document.getElementById("statusline"),
  stamp: document.getElementById("stamp"),
  reasonCode: document.getElementById("reason-code"),
  reasonLine: document.getElementById("reason-line"),
  recChip: document.getElementById("rec-chip"),
  recCode: document.getElementById("rec-code"),
  recDetail: document.getElementById("rec-detail"),
  recReason: document.getElementById("rec-reason"),
  stateDot: document.getElementById("state-dot"),
  refresh: document.getElementById("refresh"),
  theme: document.getElementById("theme"),
  where: document.getElementById("where"),
  tabs: [document.getElementById("tab-meters"), document.getElementById("tab-context")],
  panels: [
    document.getElementById("panel-meters"),
    document.getElementById("panel-context"),
  ],
};

/* ---------------------------------------------------------------- language */

/**
 * The band a percentage falls in.
 *
 *   healthy   0 to 60 inclusive
 *   watch     61 to 89
 *   critical  90 and above
 *
 * WHY NINETY, WHEN THE ENGINE SAYS EIGHTY. packages/core/src/policy.ts calls a
 * provider NEAR_CAP at 80 and stops recommending it there. That threshold is
 * not this one and must not be made to match. The agent is warned at 80 so it
 * can route away while there is still room; the human sees red at 90, when the
 * situation is actually worth reacting to. The agent being warned earlier than
 * the human sees red is the correct direction.
 *
 * Nothing here feeds back into the engine: these bands choose a colour and
 * stop. apps/web/app/app/language.ts and packages/cli/src/render.ts carry the
 * same three bands for their own surfaces.
 */
function pressureOf(percent) {
  if (!Number.isFinite(percent)) return "none";
  if (percent >= 90) return "critical";
  if (percent >= 80) return "high";
  if (percent >= 60) return "watch";
  return "ok";
}

/**
 * A credit plan, in money.
 *
 * Only ever called for a reading the normalizer let through with all three of
 * its money fields intact, so there is no half stated case to handle. The
 * spend is truncated rather than rounded, for the same reason a percentage is.
 */
function amountLine(snapshot) {
  if (
    snapshot.usedAmount === undefined ||
    snapshot.limitAmount === undefined ||
    snapshot.currency === undefined
  ) return null;
  return {
    spent: "$" + floorFixed(snapshot.usedAmount, 2),
    loaded: "$" + floorFixed(snapshot.limitAmount, 2),
  };
}

/** The same two figures as one sentence, for a screen reader. */
function amountSentence(money) {
  return money === null ? null : money.spent + " spent of " + money.loaded + " loaded";
}

/** How many of the ten blocks are full, and whether the next one is half. */
function blocks(percent) {
  const bounded = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const result = [];
  for (let index = 0; index < 10; index += 1) {
    const floor = index * 10;
    result.push(bounded >= floor + 10 ? "full" : bounded >= floor + 5 ? "half" : "empty");
  }
  return result;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A reset window in the words a person would use, two units at most. */
function countdown(resetAt, now) {
  if (resetAt === null || resetAt === undefined) return "no reset window";
  const target = Date.parse(resetAt);
  const current = Date.parse(now);
  if (!Number.isFinite(target) || !Number.isFinite(current)) return "no reset window";
  const remaining = target - current;
  if (remaining <= 0) return "reset window has passed";
  if (remaining < MINUTE) return "resets in under a minute";
  if (remaining < HOUR) return "resets in " + Math.floor(remaining / MINUTE) + "m";
  if (remaining < DAY) {
    return (
      "resets in " +
      Math.floor(remaining / HOUR) +
      "h " +
      Math.floor((remaining % HOUR) / MINUTE) +
      "m"
    );
  }
  return (
    "resets in " +
    Math.floor(remaining / DAY) +
    "d " +
    Math.floor((remaining % DAY) / HOUR) +
    "h"
  );
}

/* ------------------------------------------------------------------ dom kit */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The ten block bar, labelled for a screen reader as one image. */
function meterBar(value, state) {
  const bar = element("div", "meter");
  bar.dataset.pressure = state === "unknown" ? "none" : pressureOf(value);
  bar.dataset.state = state;
  bar.setAttribute("role", "img");
  for (const fill of blocks(state === "unknown" ? 0 : value)) {
    const block = element("span", "block");
    block.dataset.fill = fill;
    bar.append(block);
  }
  return bar;
}

function freshnessTag(state) {
  const tag = element("span", "freshness");
  const dot = element("span", "fresh-dot");
  dot.dataset.state = state;
  tag.append(dot);
  if (state === "stale") {
    const clock = element("span");
    clock.innerHTML = CLOCK_GLYPH;
    tag.append(clock);
  }
  tag.append(element("span", undefined, FRESHNESS_WORD[state] ?? state));
  return tag;
}

/**
 * One meter: its name, its freshness, its bar, its reading, its countdown.
 *
 * There are two kinds of reading, because there are two kinds of plan. A
 * rationed plan has spent a share of a window and the percentage is the
 * reading. A plan bought in credits has spent money, so the dollars take that
 * place, in the bar's own colour, and the percentage drops to the line
 * underneath. The web dashboard draws the same two shapes.
 */
function meterRow(code, value, state, resetAt, now, money) {
  const name = meterName(code);
  const row = element("div", "meter-row");

  const head = element("div", "meter-head");
  head.append(
    element("span", state === "unknown" ? "meter-name absent" : "meter-name", name),
  );
  head.append(freshnessTag(state));
  row.append(head);

  const line = element("div", "meter-line");
  const bar = meterBar(value, state);
  const sentence = amountSentence(money ?? null);
  bar.setAttribute(
    "aria-label",
    name +
      (state === "unknown"
        ? " has no reading, so it is unknown"
        : " at " +
          floorFixed(value, 1) +
          " percent, " +
          state +
          ", " +
          countdown(resetAt, now) +
          (sentence === null ? "" : ", " + sentence)),
  );
  line.append(bar);

  if (money !== null && money !== undefined && state !== "unknown") {
    const block = element("span", "meter-money");
    const spent = element("span", "spent value", money.spent);
    spent.dataset.pressure = pressureOf(value);
    block.append(spent);
    block.append(element("span", "word", " spent"));
    block.append(element("span", "loaded", "of " + money.loaded + " loaded"));
    line.append(block);
  } else {
    const number = element(
      "span",
      state === "unknown" ? "meter-value none" : "meter-value value",
      state === "unknown" ? "Unknown" : floorFixed(value, 1) + "%",
    );
    if (state !== "unknown") {
      number.dataset.pressure = pressureOf(value);
      number.dataset.state = state;
    }
    line.append(number);
  }
  row.append(line);

  const foot = element("div", "meter-foot");
  if (money !== null && money !== undefined && state !== "unknown") {
    foot.append(element("span", "meter-percent", floorFixed(value, 1) + "% used"));
    const separator = element("span", "sep", "·");
    separator.setAttribute("aria-hidden", "true");
    foot.append(separator);
  }
  foot.append(
    element(
      "span",
      "meter-reset",
      state === "unknown" ? "Not zero, not exhausted" : countdown(resetAt, now),
    ),
  );
  row.append(foot);
  return row;
}

function card(provider, snapshots, now, failure) {
  const readings = snapshots
    .map((snapshot) => ({
      snapshot,
      state: freshness(snapshot.observedAt, snapshot.expiresAt, now),
    }))
    /* Rows read in window order, shortest first and money last. The provider's
       own headline number is chosen separately, below, and is still the meter
       under the most pressure rather than whichever one happens to sort first. */
    .sort((left, right) => byMeterOrder(left.snapshot.meter, right.snapshot.meter));
  const worst = readings
    .filter((entry) => entry.state !== "unknown")
    .slice()
    .sort((left, right) => right.snapshot.value - left.snapshot.value)[0];

  const node = element("div", readings.length === 0 ? "card unknown" : "card");

  const head = element("div", "card-head");
  const identity = element("div", "card-id");
  const mark = element("span", "card-mark");
  mark.innerHTML = MARKS[provider] ?? "";
  identity.append(mark);
  const names = element("div");
  names.append(element("div", "name", PROVIDER_NAMES[provider] ?? provider));
  names.append(element("div", "code", provider));
  identity.append(names);
  head.append(identity);

  const peak = element("div", "peak");
  const peakValue = element(
    "div",
    worst === undefined ? "peak-value none" : "peak-value value",
    worst === undefined ? "No reading" : floorFixed(worst.snapshot.value, 1) + "%",
  );
  if (worst !== undefined) {
    peakValue.dataset.pressure = pressureOf(worst.snapshot.value);
    peakValue.dataset.state = worst.state;
  }
  peak.append(peakValue);
  /* One meter is the ordinary case, so saying so is filler. The count is shown
     only where it earns its place, and then as a chip rather than a caption. */
  if (readings.length > 1) {
    peak.append(element("span", "chip muted", readings.length + " meters"));
  }
  head.append(peak);
  node.append(head);

  const meters = element("div", "meters");
  for (const entry of readings) {
    meters.append(
      meterRow(
        entry.snapshot.meter,
        entry.snapshot.value,
        entry.state,
        entry.snapshot.resetAt,
        now,
        amountLine(entry.snapshot),
      ),
    );
  }
  const seen = new Set(readings.map((entry) => entry.snapshot.meter));
  const absent = (EXPECTED_METERS[provider] ?? [])
    .filter((code) => !seen.has(code))
    .sort(byMeterOrder);
  for (const code of absent) {
    meters.append(meterRow(code, 0, "unknown", null, now, null));
  }
  node.append(meters);

  /*
   * The failure line. Its sentence is a constant out of the core, keyed by a
   * category the core chose, and it is set with textContent rather than
   * innerHTML. Nothing a provider wrote can reach this element.
   */
  if (failure !== null && failure !== undefined) {
    const error = element("p", "card-error");
    error.dataset.failure = failure;
    error.setAttribute("role", "status");
    const glyph = element("span", undefined, "!");
    glyph.setAttribute("aria-hidden", "true");
    error.append(glyph);
    error.append(element("span", undefined, failureSentence[failure]));
    node.append(error);
  }

  node.append(
    element(
      "p",
      "origin",
      worst === undefined
        ? (PROVIDER_ORIGIN[provider] ?? "")
        : (PROVIDER_ORIGIN[provider] ?? "") + " · " + worst.snapshot.precision,
    ),
  );
  return node;
}

/* --------------------------------------------------------------- list view */

/** One cell of the list, with its table role and its column class. */
function cell(className, text) {
  const node = element("span", className, text);
  node.setAttribute("role", "cell");
  return node;
}

/**
 * The same readings as a dense table.
 *
 * Built from the same grouped snapshots the cards are built from, so the two
 * views cannot disagree about a number. A provider's name is drawn once per
 * group and carried invisibly on the rows underneath, where a screen reader
 * still reads it out.
 */
function listView(groups, now) {
  const root = document.createDocumentFragment();

  const head = element("div", "list-row list-head");
  head.setAttribute("role", "row");
  for (const [className, label] of [
    ["cell-ident", "Provider"],
    ["cell-meter", "Meter"],
    ["cell-bar", "Level"],
    ["cell-value", "Used"],
    ["cell-money", "Money"],
    ["cell-state", "Reading"],
    ["cell-reset", "Resets"],
  ]) {
    const node = element("span", className, label);
    node.setAttribute("role", "columnheader");
    head.append(node);
  }
  root.append(head);

  for (const group of groups) {
    group.readings.forEach((entry, index) => {
      const snapshot = entry.snapshot;
      const money = amountLine(snapshot);
      const row = element("div", "list-row");
      row.setAttribute("role", "row");
      if (index === 0) row.dataset.groupStart = "true";

      const ident = cell("cell-ident");
      if (index === 0) {
        const mark = element("span");
        mark.innerHTML = MARKS[group.provider] ?? "";
        ident.append(mark);
        ident.append(element("span", "name", PROVIDER_NAMES[group.provider] ?? group.provider));
      } else {
        ident.append(
          element("span", "only-reader", PROVIDER_NAMES[group.provider] ?? group.provider),
        );
      }
      row.append(ident);

      row.append(cell("cell-meter", meterName(snapshot.meter)));

      const bars = cell("cell-bar");
      const bar = meterBar(snapshot.value, entry.state);
      bar.setAttribute(
        "aria-label",
        meterName(snapshot.meter) +
          " at " +
          floorFixed(snapshot.value, 1) +
          " percent, " +
          entry.state,
      );
      bars.append(bar);
      row.append(bars);

      const value = cell(
        "cell-value" + (entry.state === "unknown" ? "" : " value"),
        entry.state === "unknown" ? "Unknown" : floorFixed(snapshot.value, 1) + "%",
      );
      if (entry.state !== "unknown") value.dataset.pressure = pressureOf(snapshot.value);
      row.append(value);

      row.append(
        cell("cell-money", money === null ? "" : money.spent + " of " + money.loaded),
      );

      const state = cell("cell-state");
      state.append(freshnessTag(entry.state));
      row.append(state);

      row.append(
        cell(
          "cell-reset",
          entry.state === "unknown"
            ? "Not zero, not exhausted"
            : countdown(snapshot.resetAt, now),
        ),
      );
      root.append(row);
    });
  }
  return root;
}

/* --------------------------------------------------------------- view mode */

/** Where the layout choice is kept, on this machine only. */
const VIEW_KEY = "openlimiter-view";

let currentView = "grid";

function applyView(next) {
  currentView = next === "list" ? "list" : "grid";
  const list = currentView === "list";
  elements.viewGrid.setAttribute("aria-pressed", list ? "false" : "true");
  elements.viewList.setAttribute("aria-pressed", list ? "true" : "false");
  /* The empty state owns visibility while there is nothing to show, so this
     only ever hides a container the render step decided to fill. */
  if (!elements.empty.hidden) return;
  elements.cards.hidden = list;
  elements.list.hidden = !list;
}

function chooseView(next) {
  applyView(next);
  try {
    window.localStorage.setItem(VIEW_KEY, currentView);
  } catch {
    /* Storage refused. The choice still applies to this window. */
  }
}

elements.viewGrid.addEventListener("click", () => {
  chooseView("grid");
});
elements.viewList.addEventListener("click", () => {
  chooseView("list");
});

try {
  applyView(window.localStorage.getItem(VIEW_KEY));
} catch {
  applyView("grid");
}

/* -------------------------------------------------------------------- tabs */

function selectTab(index) {
  elements.tabs.forEach((tab, position) => {
    const selected = position === index;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
    elements.panels[position].hidden = !selected;
  });
}

elements.tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => {
    selectTab(index);
  });
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + step + elements.tabs.length) % elements.tabs.length;
    selectTab(next);
    elements.tabs[next].focus();
  });
});

/* ------------------------------------------------------------------ reading */

function parseJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Everything readable on this machine, right now, and what was lost getting it.
 *
 * Two sources, both local files, both validated by the core before anything is
 * believed. A file that is missing, unreadable, or malformed contributes
 * nothing at all, which leaves its provider unknown rather than at zero.
 *
 * A row the core refused is reported against the provider it named, so that
 * card can say so in red instead of silently showing one meter fewer. A file
 * that is simply absent is not a failure and is never reported as one: this
 * window is often opened before anything has written a cache at all.
 */
async function collect(now) {
  const failures = [];

  const cacheText = await invoke("read_cache");
  const cached = parseJson(cacheText);
  let fromCache = [];
  if (cached !== null && Array.isArray(cached.snapshots)) {
    const report = normalizeMetersReport(cached.snapshots);
    fromCache = report.snapshots;
    for (const provider of report.rejected) {
      failures.push({ provider, category: "VALIDATION_REJECTED" });
    }
  }

  const manualText = await invoke("read_manual");
  const manual = parseJson(manualText);
  let fromManual = [];
  if (manual !== null) {
    const report = normalizeMetersReport(parseManualPayload(manual, now) ?? []);
    fromManual = report.snapshots;
    for (const provider of report.rejected) {
      failures.push({ provider, category: "VALIDATION_REJECTED" });
    }
  } else if (typeof manualText === "string" && manualText.trim() !== "") {
    /* A manual document exists on disk and would not parse. That is a real
       failure, and it belongs to the one provider that document can name. */
    failures.push({ provider: "MANUAL", category: "PAYLOAD_UNREADABLE" });
  }

  return {
    snapshots: mergeSnapshots(fromCache, fromManual),
    failures: dedupeFailures(failures),
  };
}

/**
 * The line that goes on the tray.
 *
 * The provider under the most pressure is the one worth glancing at, and it is
 * chosen by the advice engine rather than by this file, so the tray, the
 * statusline and the agent context can never disagree about who is closest to
 * a cap.
 */
function trayText(advice) {
  if (!advice.inject || advice.providers.length === 0) {
    return { title: "OpenLimiter", tooltip: "OpenLimiter: no reading yet." };
  }
  const worst = [...advice.providers].sort(
    (left, right) => right.usagePercent - left.usagePercent,
  )[0];
  const short = floorFixed(worst.usagePercent, 0) + "%";
  const name = PROVIDER_NAMES[worst.provider] ?? worst.provider;
  return {
    title: short,
    tooltip:
      "OpenLimiter " +
      advice.reason.toLowerCase().replace("_", " ") +
      ". Highest: " +
      name +
      " at " +
      floorFixed(worst.usagePercent, 1) +
      "%.",
  };
}

let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  try {
    const now = new Date().toISOString();
    const { snapshots, failures } = await collect(now);
    const advice = buildAdvice(snapshots, now, PROVIDER_CODES);
    const failureByProvider = new Map(
      failures.map((failure) => [failure.provider, failure.category]),
    );

    elements.cards.textContent = "";
    for (const provider of PROVIDER_CODES) {
      elements.cards.append(
        card(
          provider,
          snapshots.filter((snapshot) => snapshot.provider === provider),
          now,
          failureByProvider.get(provider) ?? null,
        ),
      );
    }

    /* The list is the same readings in the same order, grouped by provider,
       from the same snapshots the cards were built from. */
    const groups = PROVIDER_CODES.map((provider) => ({
      provider,
      readings: snapshots
        .filter((snapshot) => snapshot.provider === provider)
        .map((snapshot) => ({
          snapshot,
          state: freshness(snapshot.observedAt, snapshot.expiresAt, now),
        }))
        .sort((left, right) => byMeterOrder(left.snapshot.meter, right.snapshot.meter)),
    })).filter((group) => group.readings.length > 0);
    elements.list.textContent = "";
    elements.list.append(listView(groups, now));

    /* A failure is worth showing even when it left nothing readable behind. */
    const nothing = snapshots.length === 0 && failures.length === 0;
    elements.empty.hidden = !nothing;
    elements.cards.hidden = nothing || currentView === "list";
    elements.list.hidden = nothing || currentView !== "list";

    const context = buildAgentContext(advice);
    elements.context.textContent = context === ""
      ? "Nothing. Every provider is unknown, and silence beats a block full of guesses."
      : context;
    elements.statusline.textContent = renderClaudeStatusline(advice);

    const reason = advice.inject ? advice.reason : "UNKNOWN";
    elements.reasonCode.textContent = reason;
    elements.reasonLine.textContent = REASON_SENTENCE[reason];
    elements.stateDot.dataset.pressure = REASON_PRESSURE[reason];

    const recommendation = advice.recommendation;
    if (recommendation.code === "PREFER") {
      elements.recChip.className = "chip accent";
      elements.recCode.textContent = "PREFER " + recommendation.provider;
      elements.recDetail.textContent = recommendation.reason;
      elements.recReason.textContent = "";
      elements.recReason.hidden = true;
    } else {
      elements.recChip.className = "chip muted";
      elements.recCode.textContent = "NO RECOMMENDATION";
      elements.recDetail.textContent = "";
      elements.recReason.textContent =
        NO_RECOMMENDATION_SENTENCE[recommendation.reason] ?? "";
      elements.recReason.hidden = false;
    }

    elements.stamp.textContent = "as of " + new Date().toLocaleTimeString();

    const tray = trayText(advice);
    await invoke("set_tray_status", tray);
  } catch {
    elements.stamp.textContent = "The local cache could not be read.";
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener("click", () => {
  void refresh();
});

/*
 * The theme, and the only thing this window persists.
 *
 * Dark is the default and the head script has already applied any stored
 * choice, so all this does is flip the attribute the stylesheet keys off and
 * write the new choice down. It is the same attribute and the same storage key
 * the site's own toggle uses, so the two surfaces behave identically.
 */
elements.theme.addEventListener("click", () => {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  const next = light ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  elements.theme.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* Storage refused. The choice still applies to this window. */
  }
});

/* The tray's Refresh item reaches the window through this one event. */
void listen(REFRESH_EVENT, () => {
  void refresh();
});

void invoke("state_directory").then((directory) => {
  elements.where.textContent = directory === null
    ? "No state directory could be resolved on this system."
    : "Reading " + directory;
});

void refresh();
window.setInterval(() => {
  void refresh();
}, REFRESH_INTERVAL);
