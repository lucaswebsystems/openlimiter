/**
 * The tray popover.
 *
 * It reads the same snapshot cache the main window reads, runs it through the
 * same engine, and draws the result in a third of the space. Every rule about
 * what a valid meter is, when a reading goes stale and which window is under
 * the most pressure comes out of packages/core. Nothing about quota is decided
 * here, and this file names no threshold.
 *
 * The one design rule that governs this surface: nothing is reachable only
 * from the tray. Refresh and open exist in the main window too, so hiding the
 * tray icon costs a person convenience and never a capability. That is why
 * there is no settings control, no connect flow and no destructive action
 * here. A popover that can delete something is a popover that gets clicked by
 * accident.
 */
import {
  freshness,
  mergeSnapshots,
  normalizeMetersReport,
  readSuppressions,
  visibleSnapshots,
} from "./engine/core/index.js";
import {
  bandForPercent,
  bandIconSvg,
  providerMarkMarkup,
} from "./engine/ui/provider-row.js";
import { BACKEND_ABSENT, readCache, readManual } from "./backend.js";
import { countdownText } from "./live-meter.js";

const REFRESH_INTERVAL = 30_000;

const PROVIDER_NAMES = {
  CLAUDE: "Claude Code",
  CODEX: "Codex",
  GEMINI_CLI: "Gemini CLI",
  ANTIGRAVITY: "Antigravity",
  OPENCODE: "OpenCode",
  OPENROUTER: "OpenRouter",
  GROK: "Grok",
  KIMI: "Kimi",
  MANUAL: "Manual",
};

const WINDOW_NAMES = {
  FIVE_HOUR: "5 hour session",
  SESSION: "Session",
  HOURLY: "Hourly",
  DAILY: "Daily",
  ONE_DAY: "Daily",
  SEVEN_DAY: "Weekly",
  SEVEN_DAY_OPUS: "Weekly Opus",
  SEVEN_DAY_SONNET: "Weekly Sonnet",
  WEEKLY: "Weekly",
  THIRTY_DAY: "Monthly",
  MONTHLY: "Monthly",
  CREDITS: "Credits",
  BALANCE: "Credits",
  HARD_LIMIT: "Hard limit",
};

const BAND_NAMES = {
  green: "Normal headroom",
  yellow: "Watch threshold",
  orange: "High utilisation",
  red: "Critical depletion",
  stale: "No live reading",
};

const elements = {
  state: document.getElementById("tray-state"),
  stateText: document.getElementById("tray-state-text"),
  glance: document.getElementById("tray-glance"),
  glanceBand: document.getElementById("glance-band"),
  glanceValue: document.getElementById("glance-value"),
  glanceSubject: document.getElementById("glance-subject"),
  glanceReset: document.getElementById("glance-reset"),
  list: document.getElementById("tray-list"),
  empty: document.getElementById("tray-empty"),
  absent: document.getElementById("tray-absent"),
  observed: document.getElementById("tray-observed"),
  open: document.getElementById("tray-open"),
  refresh: document.getElementById("tray-refresh"),
};

function providerName(code) {
  return PROVIDER_NAMES[code] ?? code;
}

function windowLabel(code) {
  const known = WINDOW_NAMES[code];
  if (known !== undefined) return known;
  return code
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Every drawn window, most pressed first.
 *
 * A stale reading sorts below every live one whatever its number was: an old
 * 98 is not more urgent than a current 80, it is only louder.
 */
function rowsFrom(snapshots, now) {
  const rows = [];
  for (const snapshot of snapshots) {
    const state = freshness(snapshot.observedAt, snapshot.expiresAt, now);
    const live = state === "fresh";
    const value = state === "unknown" ? null : Math.min(100, Math.max(0, snapshot.value));
    rows.push({
      provider: snapshot.provider,
      accountId: snapshot.accountId ?? null,
      meter: snapshot.meter,
      value,
      band: live && value !== null ? bandForPercent(value) : "stale",
      live,
      resetAt: snapshot.resetAt,
      observedAt: snapshot.observedAt,
    });
  }
  rows.sort((left, right) => {
    if (left.live !== right.live) return left.live ? -1 : 1;
    const leftValue = left.value ?? -1;
    const rightValue = right.value ?? -1;
    if (leftValue !== rightValue) return rightValue - leftValue;
    return providerName(left.provider).localeCompare(providerName(right.provider));
  });
  return rows;
}

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percentText(row) {
  return row.value === null ? "--" : Math.floor(row.value) + "%";
}

function rowMarkup(row, now) {
  const account = row.accountId === null ? "" : " " + row.accountId;
  const reset = countdownText(row.resetAt, now);
  const accessible =
    providerName(row.provider) +
    account +
    ", " +
    windowLabel(row.meter) +
    ", " +
    (row.value === null ? "no reading" : percentText(row) + " used") +
    ", " +
    BAND_NAMES[row.band] +
    (reset === null ? "" : ", resets in " + reset);
  return (
    '<article class="tray-row" data-band="' +
    row.band +
    '" aria-label="' +
    escapeText(accessible) +
    '">' +
    '<span class="tray-identity"><span class="tray-mark-tile" aria-hidden="true">' +
    providerMarkMarkup(row.provider) +
    '</span><span class="tray-names">' +
    '<span class="tray-name">' +
    escapeText(providerName(row.provider) + account) +
    "</span>" +
    '<span class="tray-window">' +
    escapeText(windowLabel(row.meter)) +
    "</span></span></span>" +
    '<span class="tray-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" ' +
    (row.value === null
      ? 'aria-valuetext="No reliable reading"'
      : 'aria-valuenow="' + String(Math.round(row.value)) + '"') +
    ' aria-label="' +
    escapeText(providerName(row.provider) + " " + windowLabel(row.meter)) +
    '"><span class="tray-meter-fill" style="width:' +
    String(row.value ?? 0) +
    '%"></span></span>' +
    '<span class="tray-reset">' +
    escapeText(reset === null ? "no reset" : reset) +
    "</span>" +
    '<span class="tray-percent">' +
    bandIconSvg(row.band) +
    "<span>" +
    escapeText(percentText(row)) +
    "</span></span>" +
    "</article>"
  );
}

function paintGlance(rows, now) {
  const leader = rows.find((row) => row.live && row.value !== null) ?? rows[0];
  if (leader === undefined) {
    elements.glance.hidden = true;
    return;
  }
  elements.glance.hidden = false;
  elements.glance.dataset.band = leader.band;
  elements.glanceBand.innerHTML =
    bandIconSvg(leader.band) + "<span>" + escapeText(BAND_NAMES[leader.band]) + "</span>";
  elements.glanceValue.textContent = percentText(leader);
  elements.glanceSubject.textContent =
    providerName(leader.provider) +
    (leader.accountId === null ? "" : " " + leader.accountId) +
    ", " +
    windowLabel(leader.meter);
  const reset = countdownText(leader.resetAt, now);
  elements.glanceReset.textContent =
    reset === null ? "No reset time published" : "Resets in " + reset;
}

let rendered = [];

/** Repaint only the ticking values, once a second, on the second. */
function tick() {
  const now = Date.now();
  const cells = elements.list.querySelectorAll(".tray-reset");
  rendered.forEach((row, index) => {
    const cell = cells[index];
    if (cell === undefined) return;
    const reset = countdownText(row.resetAt, now);
    cell.textContent = reset === null ? "no reset" : reset;
  });
  if (rendered.length > 0) paintGlance(rendered, now);
  setTimeout(tick, 1000 - (Date.now() % 1000));
}

function observedSentence(rows) {
  if (rows.length === 0) return "";
  const newest = rows
    .map((row) => Date.parse(row.observedAt))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => right - left)[0];
  if (newest === undefined) return "";
  return "Observed " + new Date(newest).toLocaleTimeString();
}

/* The cache is a document on disk that this window is handed as text. It is
   parsed and validated by the same core the command line tool uses, so the
   popover and the terminal cannot disagree about what a valid row is. */
function parseJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch (error) {
    return null;
  }
}

async function collect(nowIso) {
  const cacheRead = await readCache();
  if (!cacheRead.ok && cacheRead.reason === BACKEND_ABSENT) return null;

  const cached = parseJson(cacheRead.ok ? cacheRead.value : null);
  let fromCache = [];
  if (cached !== null && Array.isArray(cached.snapshots)) {
    const report = normalizeMetersReport(cached.snapshots);
    const suppressionRead = readSuppressions(cached.suppressions);
    fromCache = suppressionRead.ok
      ? visibleSnapshots({
          snapshots: report.snapshots,
          suppressions: suppressionRead.suppressions,
        })
      : [];
  }

  const manualRead = await readManual();
  const manual = parseJson(manualRead.ok ? manualRead.value : null);
  const fromManual =
    manual === null || !Array.isArray(manual.snapshots)
      ? []
      : normalizeMetersReport(manual.snapshots).snapshots;

  return rowsFrom(mergeSnapshots(fromCache, fromManual), nowIso);
}

async function refresh() {
  const nowIso = new Date().toISOString();
  const rows = await collect(nowIso);

  if (rows === null) {
    elements.absent.hidden = false;
    elements.list.hidden = true;
    elements.empty.hidden = true;
    elements.glance.hidden = true;
    elements.state.dataset.live = "false";
    elements.stateText.textContent = "No backend";
    elements.observed.textContent = "";
    return;
  }

  elements.absent.hidden = true;
  elements.list.hidden = false;
  rendered = rows;

  if (rows.length === 0) {
    elements.empty.hidden = false;
    elements.glance.hidden = true;
    elements.list.innerHTML = "";
    elements.state.dataset.live = "false";
    elements.stateText.textContent = "Nothing connected";
    elements.observed.textContent = "";
    return;
  }

  elements.empty.hidden = true;
  const now = Date.now();
  elements.list.innerHTML = rows.map((row) => rowMarkup(row, now)).join("");
  paintGlance(rows, now);

  const anyLive = rows.some((row) => row.live);
  elements.state.dataset.live = String(anyLive);
  elements.stateText.textContent = anyLive ? "Live" : "Stale";
  elements.observed.textContent = observedSentence(rows);
}

elements.refresh?.addEventListener("click", () => {
  void refresh();
});

/*
 * Opening the main window is the tray's one job beyond reporting. The Rust
 * side owns the window, so the request goes through the same bridge every
 * other command uses and degrades to an honest no op outside the shell.
 */
elements.open?.addEventListener("click", async () => {
  const tauri = globalThis.window?.__TAURI__;
  if (typeof tauri?.core?.invoke !== "function") return;
  try {
    await tauri.core.invoke("open_main_window");
  } catch (error) {
    /* A build without the command leaves the tray as it was rather than
       reporting a failure a person cannot act on from here. */
  }
});

/* Escape closes the popover the way clicking away does. */
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const tauri = globalThis.window?.__TAURI__;
  if (typeof tauri?.core?.invoke !== "function") return;
  void tauri.core.invoke("hide_tray_popover").catch(() => {});
});

void refresh();
setInterval(() => {
  void refresh();
}, REFRESH_INTERVAL);
setTimeout(tick, 1000 - (Date.now() % 1000));
