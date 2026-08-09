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

const elements = {
  cards: document.getElementById("cards"),
  context: document.getElementById("context"),
  statusline: document.getElementById("statusline"),
  stamp: document.getElementById("stamp"),
  reasonText: document.getElementById("reason-text"),
  dot: document.getElementById("dot"),
  refresh: document.getElementById("refresh"),
  where: document.getElementById("where"),
};

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

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function instant(value) {
  if (value === null || value === undefined) return "no reset window";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "no reset window";
}

function card(provider, meters, now) {
  const readable = meters
    .map((snapshot) => ({
      snapshot,
      state: freshness(snapshot.observedAt, snapshot.expiresAt, now),
    }))
    .filter((entry) => entry.state !== "unknown")
    .sort((left, right) => right.snapshot.value - left.snapshot.value);
  const worst = readable[0];

  const node = element("div", worst === undefined ? "card unknown" : "card");
  const row = element("div", "row");
  row.append(element("span", "name", PROVIDER_NAMES[provider] ?? provider));

  if (worst === undefined) {
    row.append(element("span", "value none", "unknown"));
    node.append(row);
    node.append(
      element(
        "div",
        "meta",
        "Nothing readable was found, so nothing is claimed. Not zero, not exhausted.",
      ),
    );
    return node;
  }

  row.append(element("span", "value", floorFixed(worst.snapshot.value, 1) + "%"));
  node.append(row);

  const track = element("div", "bar-track");
  const fill = element("div", "bar-fill" + (worst.state === "stale" ? " stale" : ""));
  fill.style.width = Math.min(100, Math.max(0, worst.snapshot.value)) + "%";
  track.append(fill);
  node.append(track);

  const meta = element("div", "meta");
  meta.append(element("span", undefined, worst.snapshot.meter));
  meta.append(element("span", undefined, worst.state));
  meta.append(element("span", undefined, instant(worst.snapshot.resetAt)));
  node.append(meta);
  return node;
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

    const context = buildAgentContext(advice);
    elements.context.textContent = context === ""
      ? "Nothing. Every provider is unknown, and silence beats a block full of guesses."
      : context;
    elements.statusline.textContent = renderClaudeStatusline(advice);

    elements.reasonText.textContent = advice.reason.toLowerCase().replace("_", " ");
    elements.dot.style.background = advice.reason === "AT_CAP"
      ? "#b42318"
      : advice.reason === "NEAR_CAP"
        ? "#b45309"
        : "var(--accent)";
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
