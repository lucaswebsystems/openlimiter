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
  floorFixed,
  freshness,
  mergeSnapshots,
  normalizeMeters,
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

/*
 * The marks. Geometry written here out of lines and circles, painted in
 * currentColor, none of them a third party logo file and none of them fetched.
 * These strings are constants: nothing read off disk ever reaches innerHTML.
 */
const MARK_OPEN =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
  'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

const MARKS = {
  CLAUDE: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
  CODEX:
    '<path d="M12 2.6 20.1 7.3v9.4L12 21.4 3.9 16.7V7.3z"/><path d="m8 9.4 4 2.3 4-2.3M12 11.7v4.6"/>',
  ANTIGRAVITY: '<path d="M4 20h16"/><path d="M12 4 4.5 15h15z"/>',
  OPENCODE:
    '<path d="M8.5 4H5.5a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 5.5 20h3"/>' +
    '<path d="M15.5 4h3A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-3"/>' +
    '<path d="m10.5 9.5 2.5 2.5-2.5 2.5"/>',
  OPENROUTER:
    '<circle cx="18" cy="12" r="2.5"/><path d="M3 6h4l3.5 6H15.5M3 18h4l3.5-6"/><path d="M3 12h4"/>',
  MANUAL:
    '<path d="M5.5 3.5h9L19 8v12.5H5.5z"/><path d="M14 3.5V8h5"/><path d="M8.5 13h7M8.5 16.5h4.5"/>',
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
  HEALTHY: "healthy",
  NEAR_CAP: "critical",
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
  empty: document.getElementById("empty"),
  context: document.getElementById("context"),
  statusline: document.getElementById("statusline"),
  stamp: document.getElementById("stamp"),
  reasonCode: document.getElementById("reason-code"),
  reasonLine: document.getElementById("reason-line"),
  recCode: document.getElementById("rec-code"),
  recReason: document.getElementById("rec-reason"),
  stateDot: document.getElementById("state-dot"),
  refresh: document.getElementById("refresh"),
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
 * Eighty is the engine's own NEAR_CAP threshold, so critical begins exactly
 * where the advice engine stops recommending a provider. Sixty is a display
 * step in front of it and carries no meaning anywhere else in the product.
 */
function pressureOf(percent) {
  if (!Number.isFinite(percent)) return "none";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "watch";
  return "healthy";
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
  tag.append(element("span", undefined, state));
  return tag;
}

/** One meter: its name, its freshness, its bar, its number, its countdown. */
function meterRow(name, value, state, resetAt, now) {
  const row = element("div", "meter-row");

  const head = element("div", "meter-head");
  head.append(element("span", "meter-name", name));
  head.append(freshnessTag(state));
  row.append(head);

  const line = element("div", "meter-line");
  const bar = meterBar(value, state);
  const reading = state === "unknown" ? "unknown" : floorFixed(value, 1) + "%";
  bar.setAttribute(
    "aria-label",
    name +
      (state === "unknown"
        ? " has no reading, so it is unknown"
        : " at " + floorFixed(value, 1) + " percent, " + state + ", " + countdown(resetAt, now)),
  );
  line.append(bar);

  const number = element(
    "span",
    state === "unknown" ? "meter-value none" : "meter-value value",
    reading,
  );
  if (state !== "unknown") {
    number.dataset.pressure = pressureOf(value);
    number.dataset.state = state;
  }
  line.append(number);
  row.append(line);

  row.append(
    element(
      "p",
      "meter-reset",
      state === "unknown" ? "not zero, not exhausted" : countdown(resetAt, now),
    ),
  );
  return row;
}

function card(provider, snapshots, now) {
  const readings = snapshots
    .map((snapshot) => ({
      snapshot,
      state: freshness(snapshot.observedAt, snapshot.expiresAt, now),
    }))
    .sort((left, right) => right.snapshot.value - left.snapshot.value);
  const readable = readings.filter((entry) => entry.state !== "unknown");
  const worst = readable[0];

  const node = element("div", readings.length === 0 ? "card unknown" : "card");

  const head = element("div", "card-head");
  const identity = element("div", "card-id");
  const mark = element("span", "card-mark");
  mark.innerHTML = MARK_OPEN + (MARKS[provider] ?? "") + "</svg>";
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
    worst === undefined ? "unknown" : floorFixed(worst.snapshot.value, 1) + "%",
  );
  if (worst !== undefined) {
    peakValue.dataset.pressure = pressureOf(worst.snapshot.value);
    peakValue.dataset.state = worst.state;
  }
  peak.append(peakValue);
  peak.append(
    element(
      "div",
      "peak-note",
      worst === undefined
        ? "no reading"
        : readings.length === 1
          ? "one meter"
          : "highest of " + readings.length + " meters",
    ),
  );
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
      ),
    );
  }
  const seen = new Set(readings.map((entry) => entry.snapshot.meter));
  for (const name of EXPECTED_METERS[provider] ?? []) {
    if (!seen.has(name)) meters.append(meterRow(name, 0, "unknown", null, now));
  }
  node.append(meters);

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
 * Everything readable on this machine, right now.
 *
 * Two sources, both local files, both validated by the core before anything is
 * believed. A file that is missing, unreadable, or malformed contributes
 * nothing at all, which leaves its provider unknown rather than at zero.
 */
async function collect(now) {
  const cached = parseJson(await invoke("read_cache"));
  const fromCache = cached !== null && Array.isArray(cached.snapshots)
    ? normalizeMeters(cached.snapshots)
    : [];

  const manual = parseJson(await invoke("read_manual"));
  const fromManual = manual === null
    ? []
    : normalizeMeters(parseManualPayload(manual, now) ?? []);

  return mergeSnapshots(fromCache, fromManual);
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
    const snapshots = await collect(now);
    const advice = buildAdvice(snapshots, now, PROVIDER_CODES);

    elements.cards.textContent = "";
    for (const provider of PROVIDER_CODES) {
      elements.cards.append(
        card(
          provider,
          snapshots.filter((snapshot) => snapshot.provider === provider),
          now,
        ),
      );
    }
    const nothing = snapshots.length === 0;
    elements.cards.hidden = nothing;
    elements.empty.hidden = !nothing;

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
      elements.recCode.textContent = "PREFER " + recommendation.provider;
      elements.recReason.textContent = recommendation.reason;
    } else {
      elements.recCode.textContent = "NO RECOMMENDATION";
      elements.recReason.textContent =
        NO_RECOMMENDATION_SENTENCE[recommendation.reason] ?? "";
    }

    elements.stamp.textContent = "Read at " + new Date().toLocaleTimeString();

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
