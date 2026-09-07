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
 *
 * The file has two halves. The first is the vocabulary and the arithmetic: how
 * a window is named, where it sorts, what a row is allowed to claim, and where
 * an even burn would have put the bar by now. It touches no document and is
 * exported, so a test reads the shipped rules rather than a second copy of
 * them. The second half is the wiring, and it is the only half that knows a
 * window exists.
 */
import { BACKEND_ABSENT, readCache, readManual } from "./backend.js";

const REFRESH_INTERVAL = 30_000;

const TRIAL_URL = "https://openlimiter.com/app?trial=1";
const PAIR_URL = "https://openlimiter.com/app/pair";

const PROVIDER_NAMES = Object.freeze({
  CLAUDE: "Claude Code",
  CODEX: "Codex",
  GEMINI_CLI: "Gemini CLI",
  ANTIGRAVITY: "Antigravity",
  OPENCODE: "OpenCode",
  OPENROUTER: "OpenRouter",
  GROK: "Grok",
  KIMI: "Kimi",
  MANUAL: "Manual",
});

/*
 * The window vocabulary, mirrored from packages/ui/src/provider-row.ts.
 *
 * The tray and the main window are one product, and a person who reads
 * "Weekly (Fable 5)" in one and "Seven day fable 5" in the other is looking at
 * two products. This map, the rank table under it and the naming function
 * below are the same rules the shared row applies, so a code the shared row
 * knows resolves identically here. A test holds the two side by side.
 */
const WINDOW_NAMES = Object.freeze({
  FIVE_HOUR: "5 hour session",
  SESSION: "Session",
  PRIMARY: "Primary window",
  SECONDARY: "Secondary window",
  HOURLY: "Hourly",
  FIVE_MINUTE: "5 minute window",
  DAILY: "Daily",
  ONE_DAY: "Daily",
  SEVEN_DAY: "Weekly",
  SEVEN_DAY_OPUS: "Weekly Opus",
  SEVEN_DAY_SONNET: "Weekly Sonnet",
  SEVEN_DAY_OAUTH_APPS: "Weekly OAuth apps",
  EXTRA_USAGE: "Extra usage",
  WEEKLY: "Weekly",
  THIRTY_DAY: "Monthly",
  MONTHLY: "Monthly",
  ON_DEMAND_MONTHLY: "On demand monthly",
  CREDITS: "Credits",
  BALANCE: "Credits",
  HARD_LIMIT: "Hard limit",
  LIMIT: "Hard limit",
});

/** Where a model specific weekly bucket sorts: with the week, before the month. */
const MODEL_WEEKLY_RANK = 45;

/** The prefix Claude builds every model specific weekly code on. */
const MODEL_WEEKLY_PREFIX = "SEVEN_DAY_";

const WINDOW_RANK = Object.freeze({
  FIVE_HOUR: 10,
  SESSION: 10,
  PRIMARY: 15,
  SECONDARY: 16,
  HOURLY: 20,
  FIVE_MINUTE: 5,
  DAILY: 30,
  ONE_DAY: 30,
  SEVEN_DAY: 40,
  SEVEN_DAY_OPUS: 41,
  SEVEN_DAY_SONNET: 42,
  SEVEN_DAY_OAUTH_APPS: 43,
  WEEKLY: 40,
  THIRTY_DAY: 50,
  MONTHLY: 50,
  ON_DEMAND_MONTHLY: 51,
  EXTRA_USAGE: 52,
  CREDITS: 60,
  BALANCE: 60,
  HARD_LIMIT: 70,
  LIMIT: 70,
});

const BAND_NAMES = Object.freeze({
  green: "Normal headroom",
  yellow: "Watch threshold",
  orange: "High utilisation",
  red: "Critical depletion",
  stale: "No live reading",
});

/*
 * Every fixed sentence this popover can say, in one place.
 *
 * Copy scattered through a renderer is copy nobody can audit, and this surface
 * has a house rule that no string a person reads carries a dash of any kind. A
 * single table is what lets a test read all of them at once.
 *
 * `noValue` is the compact token, because the percentage column is three
 * characters wide and the full sentence does not fit in it. The accessible
 * label says "no reading" in full, so nothing is abbreviated for the person
 * who cannot see the hatched bar beside it.
 */
const COPY = Object.freeze({
  live: "Live",
  stale: "Stale",
  reading: "Reading",
  noBackend: "No backend",
  nothingConnected: "Nothing connected",
  noReading: "no reading",
  noReliableReading: "No reliable reading",
  noValue: "n/a",
  noReset: "no reset",
  noResetPublished: "No reset time published",
  resetsIn: "Resets in ",
  resetsInClause: ", resets in ",
  observed: "Observed ",
  usageWindow: "Usage window",
});

function held(table, key) {
  return typeof key === "string" && Object.hasOwn(table, key)
    ? table[key]
    : undefined;
}

function capitalise(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function providerName(code) {
  return held(PROVIDER_NAMES, code) ?? code;
}

/*
 * A model specific weekly bucket, in words.
 *
 * Claude states one weekly pool per model and builds the code out of a name it
 * chose, so no build can hold a label for each one and none of them may be
 * shouted at a person as a code. The cadence stays in front, where the eye
 * reads it, and the model follows in brackets: SEVEN_DAY_FABLE_5 reads as
 * "Weekly (Fable 5)". An explicit label always wins, because "Weekly Opus" was
 * shipped first and reads better than the generated form.
 */
function modelWeeklyName(code) {
  if (!code.startsWith(MODEL_WEEKLY_PREFIX)) return null;
  const words = code
    .slice(MODEL_WEEKLY_PREFIX.length)
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return null;
  return "Weekly (" + words.map(capitalise).join(" ") + ")";
}

/**
 * The name of one window, for a person.
 *
 * A code with no entry anywhere still has to read as English, which is what
 * carries a meter this build has never seen. ANTIGRAVITY's incoming
 * THIRD_PARTY_SESSION arrives at the last branch and leaves it as "Third party
 * session", with no release of this file required to make it legible.
 */
function windowLabel(code, provider) {
  if (provider === "OPENROUTER" && (code === "CREDITS" || code === "BALANCE")) {
    return "Credit spend";
  }
  const known = held(WINDOW_NAMES, code);
  if (known !== undefined) return known;
  const modelWeekly = modelWeeklyName(code);
  if (modelWeekly !== null) return modelWeekly;
  const numbered = code.match(/^(.+)_([2-9][0-9]*)$/u);
  if (numbered !== null) {
    const base = held(WINDOW_NAMES, numbered[1] ?? "");
    if (base !== undefined) return base + " " + (numbered[2] ?? "");
  }
  const words = code
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter((word) => word !== "");
  if (words.length === 0) return COPY.usageWindow;
  if (provider === "GEMINI_CLI" && words[0] === "gemini") {
    return words
      .map(capitalise)
      .join(" ")
      .replace(/([0-9]) ([0-9])/gu, "$1.$2");
  }
  return words
    .map((word, index) => (index === 0 ? capitalise(word) : word))
    .join(" ");
}

/** Where a window sorts inside its own account: session, week, model, month. */
function windowRank(code) {
  const known = held(WINDOW_RANK, code);
  if (known !== undefined) return known;
  return code.startsWith(MODEL_WEEKLY_PREFIX) ? MODEL_WEEKLY_RANK : 90;
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

/** How long the provider says this window runs, in milliseconds, or nothing. */
function windowMillis(window) {
  const seconds = window?.durationSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return seconds * 1000;
}

/**
 * One drawn row, out of one snapshot and the freshness the core decided.
 *
 * An unknown reading loses two things here rather than in the renderer: its
 * percentage and its reset time. The number is gone because there is no
 * trustworthy one, and the clock is gone with it, because a countdown ticking
 * beside a hatched bar is the popover inventing the only fact the row does not
 * have. A merely stale reading keeps both: it was true when it was taken, and
 * the hatch is what says how long ago that was.
 */
function buildRow(snapshot, state, bandForPercent) {
  const live = state === "fresh";
  const value = state === "unknown" ? null : clampPercent(snapshot.value);
  return {
    provider: snapshot.provider,
    accountId: snapshot.accountId ?? null,
    meter: snapshot.meter,
    value,
    band: live && value !== null ? bandForPercent(value) : "stale",
    live,
    state,
    resetAt: state === "unknown" ? null : (snapshot.resetAt ?? null),
    windowMs: windowMillis(snapshot.window),
    observedAt: snapshot.observedAt,
  };
}

function groupKey(row) {
  return row.provider + " " + (row.accountId ?? "");
}

/**
 * Every drawn window, most pressed account first, in cadence order inside it.
 *
 * Two rules are at work and they answer different questions. Across accounts
 * the list is ordered by pressure, because the popover is opened to find out
 * who is about to run out. Inside one account the list is ordered by cadence,
 * session then week then model week then month, because a person reading their
 * own Claude rows is reading a set of nested windows and shuffling them by
 * percentage makes the set unreadable.
 *
 * A stale reading still sorts below every live one whatever its number was: an
 * old 98 is not more urgent than a current 80, it is only louder.
 */
function sortRows(rows) {
  const peak = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    const pressure = row.live && row.value !== null ? row.value : -1;
    peak.set(key, Math.max(peak.get(key) ?? -1, pressure));
  }
  return [...rows].sort((left, right) => {
    if (left.live !== right.live) return left.live ? -1 : 1;
    const leftKey = groupKey(left);
    const rightKey = groupKey(right);
    if (leftKey !== rightKey) {
      const pressure = (peak.get(rightKey) ?? -1) - (peak.get(leftKey) ?? -1);
      if (pressure !== 0) return pressure;
      const named = providerName(left.provider).localeCompare(
        providerName(right.provider),
      );
      if (named !== 0) return named;
      return (left.accountId ?? "").localeCompare(right.accountId ?? "");
    }
    const rank = windowRank(left.meter) - windowRank(right.meter);
    return rank !== 0 ? rank : left.meter.localeCompare(right.meter);
  });
}

/**
 * The one window the headline speaks for.
 *
 * It is chosen here rather than taken from the top of the list, because the
 * list is grouped by account now and its first row is the shortest window of
 * the hottest account rather than the hottest window on the machine. The
 * headline answers "am I about to be cut off", so it reads the highest live
 * percentage anywhere and breaks a tie towards the window that resets soonest.
 */
function leadRow(rows) {
  let lead = null;
  for (const row of rows) {
    if (!row.live || row.value === null) continue;
    if (lead === null || row.value > lead.value) {
      lead = row;
      continue;
    }
    if (
      row.value === lead.value &&
      windowRank(row.meter) < windowRank(lead.meter)
    ) {
      lead = row;
    }
  }
  return lead ?? rows[0] ?? null;
}

/**
 * Where an even burn would have put this bar by now, as a percentage.
 *
 * The fill is the present and this is the projection, so the two together
 * answer "am I on pace" without a word of text or a pixel of row height. The
 * only inputs are facts the snapshot already states: the window's length and
 * the instant it resets give the moment it began, and how far the clock has
 * travelled between those two is exactly where a steady spend would be.
 *
 * It returns nothing at all unless the row is live, holds a real number, and
 * carries both a reset and a duration, and nothing when the clock sits outside
 * the window the provider stated. A tick drawn on any other row would be a
 * guess wearing a measurement's clothes.
 */
function paceTickPercent(row, now) {
  if (!row.live || row.value === null) return null;
  if (row.resetAt === null || row.windowMs === null) return null;
  if (!Number.isFinite(row.windowMs) || row.windowMs <= 0) return null;
  const reset = Date.parse(row.resetAt);
  if (!Number.isFinite(reset) || !Number.isFinite(now)) return null;
  const fraction = (row.windowMs - (reset - now)) / row.windowMs;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  return fraction * 100;
}

/** The percentage column, which says nothing rather than a number it lacks. */
function percentText(row) {
  return row.value === null ? COPY.noValue : Math.floor(row.value) + "%";
}

/** The countdown column. An unknown reading has no clock to show. */
function resetCellText(row, countdown) {
  if (row.state === "unknown") return "";
  return countdown === null ? COPY.noReset : countdown;
}

/** The headline's own reset line, held to the same rule. */
function glanceResetText(row, countdown) {
  if (row.state === "unknown") return "";
  return countdown === null ? COPY.noResetPublished : COPY.resetsIn + countdown;
}

/** Everything one row says, in one sentence, for a person who cannot see it. */
function accessibleSentence(row, countdown) {
  const account = row.accountId === null ? "" : " " + row.accountId;
  return (
    providerName(row.provider) +
    account +
    ", " +
    windowLabel(row.meter, row.provider) +
    ", " +
    (row.value === null ? COPY.noReading : percentText(row) + " used") +
    ", " +
    BAND_NAMES[row.band] +
    (countdown === null || row.state === "unknown"
      ? ""
      : COPY.resetsInClause + countdown)
  );
}

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export {
  accessibleSentence,
  BAND_NAMES,
  buildRow,
  COPY,
  escapeText,
  glanceResetText,
  leadRow,
  paceTickPercent,
  PAIR_URL,
  percentText,
  PROVIDER_NAMES,
  providerName,
  resetCellText,
  sortRows,
  TRIAL_URL,
  windowLabel,
  WINDOW_NAMES,
  WINDOW_RANK,
  windowRank,
};

/*
 * The wiring.
 *
 * Three modules below this line are asked for when the popover starts rather
 * than when this file is parsed. The engine is assembled into ui/dist by the
 * build and does not sit beside this file in a checkout, and the live meter
 * extends a class only a browser defines, so both exist only inside the
 * window. The rules above are arithmetic that has to be readable without one,
 * which is what keeps a single copy of them in the shipped file.
 */
let core = null;
let shared = null;
let countdownText = null;
let elements = null;
let rendered = [];

function rowMarkup(row, now) {
  const account = row.accountId === null ? "" : " " + row.accountId;
  const countdown = countdownText(row.resetAt, now);
  const pace = paceTickPercent(row, now);
  return (
    '<article class="tray-row" data-band="' +
    row.band +
    '" aria-label="' +
    escapeText(accessibleSentence(row, countdown)) +
    '">' +
    '<span class="tray-identity"><span class="tray-mark-tile" aria-hidden="true">' +
    shared.providerMarkMarkup(row.provider) +
    '</span><span class="tray-names">' +
    '<span class="tray-name">' +
    escapeText(providerName(row.provider) + account) +
    "</span>" +
    '<span class="tray-window">' +
    escapeText(windowLabel(row.meter, row.provider)) +
    "</span></span></span>" +
    '<span class="tray-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" ' +
    (row.value === null
      ? 'aria-valuetext="' + COPY.noReliableReading + '"'
      : 'aria-valuenow="' + String(Math.round(row.value)) + '"') +
    ' aria-label="' +
    escapeText(providerName(row.provider) + " " + windowLabel(row.meter, row.provider)) +
    '"><span class="tray-meter-fill" style="width:' +
    String(row.value ?? 0) +
    '%"></span>' +
    /* The projection, laid over the fill it is there to be compared against.
       It is hidden from assistive technology because the sentence on the row
       already states the percentage and the countdown it comes from. */
    (pace === null
      ? ""
      : '<span class="tray-pace" aria-hidden="true" style="left:' +
        pace.toFixed(1) +
        '%"></span>') +
    "</span>" +
    '<span class="tray-reset">' +
    escapeText(resetCellText(row, countdown)) +
    "</span>" +
    '<span class="tray-percent">' +
    shared.bandIconSvg(row.band) +
    "<span>" +
    escapeText(percentText(row)) +
    "</span></span>" +
    "</article>"
  );
}

function paintGlance(rows, now) {
  const leader = leadRow(rows);
  if (leader === null) {
    elements.glance.hidden = true;
    return;
  }
  elements.glance.hidden = false;
  elements.glance.dataset.band = leader.band;
  elements.glanceBand.innerHTML =
    shared.bandIconSvg(leader.band) +
    "<span>" +
    escapeText(BAND_NAMES[leader.band]) +
    "</span>";
  elements.glanceValue.textContent = percentText(leader);
  elements.glanceSubject.textContent =
    providerName(leader.provider) +
    (leader.accountId === null ? "" : " " + leader.accountId) +
    ", " +
    windowLabel(leader.meter, leader.provider);
  elements.glanceReset.textContent = glanceResetText(
    leader,
    countdownText(leader.resetAt, now),
  );
}

function rowsFrom(snapshots, now) {
  const rows = snapshots.map((snapshot) =>
    buildRow(
      snapshot,
      core.freshness(snapshot.observedAt, snapshot.expiresAt, now),
      shared.bandForPercent,
    ),
  );
  return sortRows(rows);
}

/** Repaint only the ticking values, once a second, on the second. */
function tick() {
  const now = Date.now();
  const cells = elements.list.querySelectorAll(".tray-reset");
  rendered.forEach((row, index) => {
    const cell = cells[index];
    if (cell === undefined) return;
    cell.textContent = resetCellText(row, countdownText(row.resetAt, now));
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
  return COPY.observed + new Date(newest).toLocaleTimeString();
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
    const report = core.normalizeMetersReport(cached.snapshots);
    const suppressionRead = core.readSuppressions(cached.suppressions);
    fromCache = suppressionRead.ok
      ? core.visibleSnapshots({
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
      : core.normalizeMetersReport(manual.snapshots).snapshots;

  return rowsFrom(core.mergeSnapshots(fromCache, fromManual), nowIso);
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
    elements.stateText.textContent = COPY.noBackend;
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
    elements.stateText.textContent = COPY.nothingConnected;
    elements.observed.textContent = "";
    return;
  }

  elements.empty.hidden = true;
  const now = Date.now();
  elements.list.innerHTML = rows.map((row) => rowMarkup(row, now)).join("");
  paintGlance(rows, now);

  const anyLive = rows.some((row) => row.live);
  elements.state.dataset.live = String(anyLive);
  elements.stateText.textContent = anyLive ? COPY.live : COPY.stale;
  elements.observed.textContent = observedSentence(rows);
}

async function start() {
  const [coreModule, sharedModule, meterModule] = await Promise.all([
    import("./engine/core/index.js"),
    import("./engine/ui/provider-row.js"),
    import("./live-meter.js"),
  ]);
  core = coreModule;
  shared = sharedModule;
  countdownText = meterModule.countdownText;

  elements = {
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

  await refresh();
  setInterval(() => {
    void refresh();
  }, REFRESH_INTERVAL);
  setTimeout(tick, 1000 - (Date.now() % 1000));
}

/* A document is the one thing the wiring cannot do without. Node imports this
   file for the rules above and never reaches this line's other side. */
if (typeof document !== "undefined") void start();
