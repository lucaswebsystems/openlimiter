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
 * Rust sits behind ./backend.js for everything this file cannot do itself:
 * the state directory, the two local files, the system tray, and the
 * connection subsystem the Connections tab drives. Nothing crosses the
 * boundary anywhere else, and nothing leaves the machine except the provider
 * reads a person has explicitly connected.
 */
import {
  PROVIDER_CODES,
  buildAdvice,
  connectionSentence,
  dedupeFailures,
  failureSentence,
  floorFixed,
  freshness,
  mergeSnapshots,
  normalizeMetersReport,
} from "./engine/core/index.js";
import { PROVIDER_SPECS } from "./provider-specs.generated.js";
import { parseManualPayload } from "./engine/connectors/manual.js";
import {
  buildAgentContext,
  renderClaudeStatusline,
} from "./engine/adapters/claude-code.js";
/* Every word the Rust process hears from this file goes through the backend
   adapter, so a build without a given command degrades to an honest absence
   instead of a module level crash, and a static serve of these files renders
   the empty state rather than nothing at all. */
import {
  BACKEND_ABSENT,
  connectProvider,
  listConnections,
  normalizeCollectionOutcome,
  normalizeConnection,
  normalizeConnectionList,
  readCache,
  readManual,
  setTrayStatus,
  stateDirectory,
  testProvider,
} from "./backend.js";
import {
  connectionFactFor,
  connectionsTabShown,
  initConnections,
  noteMetersRefreshed,
  stateWord,
} from "./connections.js";

/** How often the window re reads the cache, in milliseconds. */
const REFRESH_INTERVAL = 30_000;

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
 * Manual entry is not a company at all and keeps its own glyph: a person
 * writing a number down.
 *
 * These strings are constants. Nothing read off disk ever reaches innerHTML.
 */
const FILLED_OPEN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">';

const STROKED_OPEN =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

const MARKS = {
  CLAUDE: FILLED_OPEN + '<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  OPENROUTER: FILLED_OPEN + '<path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"/></svg>',
  OPENCODE: FILLED_OPEN + '<path d="M22 24H2V0h20zM17 4.8H7v14.4h10z"/></svg>',
  /* Antigravity is Google's, and takes the Google mark the catalogue gives it. */
  ANTIGRAVITY: FILLED_OPEN + '<path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
  CODEX:
    FILLED_OPEN +
    '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  MANUAL:
    STROKED_OPEN +
    '<path d="M16.6 3.6a2 2 0 0 1 2.8 2.8L8.5 17.3l-3.7.9.9-3.7Z"/>' +
    '<path d="m14.6 5.6 3.8 3.8M4 21h16"/></svg>',
};

const CLOCK_GLYPH =
  '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" aria-hidden="true" focusable="false">' +
  '<circle cx="6" cy="6" r="4.6"/><path d="M6 3.4V6l1.9 1.2"/></svg>';

/* The same sentences apps/web/app/app/language.ts renders, word for word,
   with the % sign the reference uses rather than the word. */
const REASON_PRESSURE = {
  HEALTHY: "ok",
  NEAR_CAP: "high",
  AT_CAP: "critical",
  UNKNOWN: "none",
};

const elements = {
  cards: document.getElementById("cards"),
  empty: document.getElementById("empty"),
  context: document.getElementById("context"),
  statusline: document.getElementById("statusline"),
  stamp: document.getElementById("stamp"),
  reasonCode: document.getElementById("reason-code"),
  recChip: document.getElementById("rec-chip"),
  recCode: document.getElementById("rec-code"),
  recDetail: document.getElementById("rec-detail"),
  stateDot: document.getElementById("state-dot"),
  refresh: document.getElementById("refresh"),
  theme: document.getElementById("theme"),
  where: document.getElementById("where"),
  tabs: [
    document.getElementById("tab-meters"),
    document.getElementById("tab-connections"),
    document.getElementById("tab-advanced"),
  ],
  panels: [
    document.getElementById("panel-meters"),
    document.getElementById("panel-connections"),
    document.getElementById("panel-advanced"),
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

/**
 * A reading as bar geometry, clamped to the track and nothing else.
 *
 * The bar this feeds is continuous. It used to be ten blocks with a half step
 * every five percent, which drew 91 and 97 identically and rounded away exactly
 * the room somebody opens this window to check. Nothing is bucketed here: the
 * only arithmetic is the clamp, because a track cannot be longer than itself. A
 * value that is not a number is not a zero, so this returns null and the caller
 * draws the unknown track, which has no fill in it.
 *
 * apps/web/app/app/language.ts carries the same two functions, so the window
 * and the browser dashboard cannot draw one reading two lengths.
 */
function meterFraction(percent) {
  if (!Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, percent));
}

/** The same clamped reading as a CSS width, every decimal intact. */
function meterWidth(percent) {
  const fraction = meterFraction(percent);
  return fraction === null ? null : String(fraction) + "%";
}

/**
 * Where this provider's numbers came from, and almost never the word connected.
 *
 * Same four states and the same tables as the web dashboard's language module.
 * A parser existing is not a connection: the payload for most of these has to
 * be handed over by something else, and the card says so. CONNECTED is earned,
 * not inherited: a row stamped remote_api gets the word only after a live
 * refresh has actually succeeded in this run of this window, because a stamp
 * in the cache can outlive the credential and the build that wrote it.
 * Otherwise the chip carries the connection state machine's own word for what
 * the connection is right now, which sourceChip below decides.
 */
const SOURCE_LABEL = {
  LOCAL_CLI: "Local CLI",
  IMPORT_ONLY: "Import only",
  MANUAL: "Manual",
  CONNECTED: "Connected",
};

const SOURCE_SENTENCE = {
  LOCAL_CLI: "A tool on this machine writes the payload, and OpenLimiter reads what it wrote.",
  IMPORT_ONLY:
    "The payload shape is parsed. Nothing here signs in or fetches it, so you supply the document.",
  MANUAL: "Figures you keep yourself. Nothing is read from an account.",
  CONNECTED:
    "OpenLimiter held a credential and asked the provider itself, and that read succeeded in this run of this window.",
};

const PROVIDER_DEFAULT_SOURCE = {
  CLAUDE: "LOCAL_CLI",
  OPENROUTER: "IMPORT_ONLY",
  CODEX: "IMPORT_ONLY",
  ANTIGRAVITY: "IMPORT_ONLY",
  OPENCODE: "IMPORT_ONLY",
  MANUAL: "MANUAL",
};

/**
 * A stamped provenance, as a source state. `unknown` maps to nothing, so a
 * stamp the normalizer could not believe never overrules a sound literal.
 */
const PROVENANCE_SOURCE_STATE = {
  statusline_payload: "LOCAL_CLI",
  explicit_ingest: "IMPORT_ONLY",
  manual_document: "MANUAL",
  remote_api: "CONNECTED",
  unknown: null,
};

/**
 * Provenance first, then the source literal.
 *
 * `source` describes the shape of the document, so a Claude statusline block
 * pasted out of a chat log is still `native_payload` and used to chip as Local
 * CLI. `provenance.sourceKind` is our own word for how the reading arrived and
 * is written by whatever read it, so it wins whenever it is there. Absent or
 * `unknown` falls through to the literal logic unchanged, which is what every
 * row written before provenance existed relies on.
 */
function sourceStateOf(provider, source, provenance) {
  const stamped =
    provenance === undefined || provenance === null
      ? null
      : (PROVENANCE_SOURCE_STATE[provenance.sourceKind] ?? null);
  if (stamped !== null) return stamped;
  if (source === "native_payload") return "LOCAL_CLI";
  if (source === "manual_entry") return "MANUAL";
  if (source !== undefined && source !== null) return "IMPORT_ONLY";
  return PROVIDER_DEFAULT_SOURCE[provider] ?? "IMPORT_ONLY";
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

/**
 * The bar, and it is continuous.
 *
 * A real progressbar rather than an image, so `aria-valuenow` carries the exact
 * reading instead of the drawn approximation of it. The fill's width is set
 * from that same number with every decimal intact, and geometry never depends
 * on which colour band the number falls in.
 *
 * Unknown gets no fill element and no `aria-valuenow` at all, which is how ARIA
 * spells a progressbar with no value. A zero width fill on a full width track
 * is a picture of an exhausted quota, and an absent reading is not that.
 *
 * @param {number} value    the percentage, or anything at all when unknown
 * @param {string} state    fresh, stale or unknown
 * @param {boolean} compact true in the list, where there is no room for a word
 */
function meterBar(value, state, compact = false) {
  const unknown = state === "unknown";
  const width = unknown ? null : meterWidth(value);
  const bar = element("div", compact ? "meter meter-sm" : "meter");
  bar.dataset.pressure = width === null ? "none" : pressureOf(value);
  bar.dataset.state = state;
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  if (width === null) {
    bar.setAttribute("aria-valuetext", "Unknown");
    if (!compact) bar.append(element("span", "meter-word", "Unknown"));
  } else {
    /* Exact for a machine, speakable for a person: a credit balance of 12.47
       out of 20 is 62.35000000000001, which is the honest value to expose and
       an absurd thing to read aloud one digit at a time. */
    bar.setAttribute("aria-valuenow", String(meterFraction(value)));
    bar.setAttribute("aria-valuetext", floorFixed(value, 1) + "% used");
    const fill = element("span", "meter-fill");
    fill.setAttribute("aria-hidden", "true");
    fill.style.width = width;
    bar.append(fill);
  }
  return bar;
}

/**
 * Where a reading came from, as the chip every card and row carries.
 *
 * The one gate in it: a row whose provenance claims a remote read says
 * Connected only when refresh_provider actually came back CONNECTED in this
 * run of this window. Any other remote stamped row, an older build's write,
 * a stalled connection, a build with no connection backend at all, carries
 * the connection state machine's own word instead, and NOT_CONFIGURED when
 * no connection record exists to speak for it. The claim on the chip is
 * always a claim about this exact build.
 */
function sourceChip(provider, source, provenance) {
  const state = sourceStateOf(provider, source, provenance);
  const chip = element("span", "chip muted source-chip");
  const dot = element("span", "source-dot");
  dot.setAttribute("aria-hidden", "true");
  chip.append(dot);
  if (state === "CONNECTED") {
    const fact = connectionFactFor(provider);
    if (fact === null || !fact.liveOk) {
      const connectionState = fact?.state ?? "NOT_CONFIGURED";
      /* The word is the machine's, always. The styling is not: a record that
         says CONNECTED without a live refresh in this run keeps the neutral
         dot, so the bright dot stays a claim only this run can make. */
      chip.dataset.source =
        connectionState === "CONNECTED" ? "CONNECTED_UNVERIFIED" : connectionState;
      chip.title =
        connectionState +
        ". " +
        connectionSentence[connectionState] +
        " A row gets the bright Connected dot only after a live refresh succeeds in this run.";
      chip.append(element("span", undefined, stateWord(connectionState)));
      return chip;
    }
  }
  chip.dataset.source = state;
  chip.title = state + ". " + SOURCE_SENTENCE[state];
  chip.append(element("span", undefined, SOURCE_LABEL[state]));
  return chip;
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
  } else if (state !== "unknown") {
    const number = element("span", "meter-value value", floorFixed(value, 1) + "%");
    number.dataset.pressure = pressureOf(value);
    number.dataset.state = state;
    line.append(number);
  }
  /* An unknown row says so inside its own track and nowhere else, so the value
     column is left out rather than repeating the word beside the bar. */
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
    /* Most constrained real meter first, then other real windows, then unknown meters. */
    .sort((left, right) => {
      const leftUnknown = left.state === "unknown";
      const rightUnknown = right.state === "unknown";
      if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1;
      if (!leftUnknown && !rightUnknown) {
        const difference = right.snapshot.value - left.snapshot.value;
        if (difference !== 0) return difference;
      }
      return byMeterOrder(left.snapshot.meter, right.snapshot.meter);
    });
  const worst = readings.find((entry) => entry.state !== "unknown");

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

  /* Where these numbers came from, on the card that shows them. A parser is
     still not a connection: the chip says Connected, with the bright dot,
     only when a live refresh actually reached the cache in this run of this
     window. Any other remote stamped row carries the connection state
     machine's own word instead. sourceChip holds the gate. */
  const origin = element("div", "origin");
  /* One reading answers for the card, and both of its facts come from that same
     reading: a literal from one row and a stamp from another would describe an
     arrival nothing here saw. */
  const lead = (worst ?? readings[0])?.snapshot;
  origin.append(sourceChip(provider, lead?.source, lead?.provenance));
  origin.append(
    element(
      "p",
      "origin-line",
      worst === undefined
        ? (PROVIDER_ORIGIN[provider] ?? "")
        : (PROVIDER_ORIGIN[provider] ?? "") + " · " + worst.snapshot.precision,
    ),
  );
  node.append(origin);
  return node;
}



/* -------------------------------------------------------------------- tabs */

let initialTabDetermined = false;

function selectTab(index, isUserClick = false) {
  if (isUserClick) {
    initialTabDetermined = true;
  }
  elements.tabs.forEach((tab, position) => {
    if (!tab) return;
    const selected = position === index;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
    if (elements.panels[position]) {
      elements.panels[position].hidden = !selected;
    }
  });
  /* Bringing the Connections tab on screen re-asks the backend whether it is
     there, so an absent block never describes a build that has since changed. */
  if (elements.tabs[index] === document.getElementById("tab-connections")) {
    connectionsTabShown();
    updateConnectSectionVisibility();
    decorateConnectionCardsHonestyLabels();
  }
}

elements.tabs.forEach((tab, index) => {
  if (!tab) return;
  tab.addEventListener("click", () => {
    selectTab(index, true);
  });
  tab.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = (index + step + elements.tabs.length) % elements.tabs.length;
    selectTab(next, true);
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

  /* Through the adapter, so a page served outside the shell reads nothing
     and claims nothing instead of crashing. Absence is not a failure: this
     window is often opened before anything has written a cache at all. */
  const cacheRead = await readCache();
  const cacheText = cacheRead.ok ? cacheRead.value : null;
  const cached = parseJson(cacheText);
  let fromCache = [];
  if (cached !== null && Array.isArray(cached.snapshots)) {
    const report = normalizeMetersReport(cached.snapshots);
    fromCache = report.snapshots;
    for (const provider of report.rejected) {
      failures.push({ provider, category: "VALIDATION_REJECTED" });
    }
  }

  const manualRead = await readManual();
  const manualText = manualRead.ok ? manualRead.value : null;
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

/**
 * Whether a fresh Claude reading that arrived through the local statusline is
 * in the cache right now. The Connections tab reads this to tell "ready to
 * collect" apart from "collecting": the wiring being present is one fact, a
 * payload actually flowing is another, and only the cache knows the second.
 */
let freshLocalClaude = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  try {
    const now = new Date().toISOString();
    const { snapshots, failures } = await collect(now);
    const advice = buildAdvice(snapshots, now, PROVIDER_CODES);
    freshLocalClaude = snapshots.some(
      (snapshot) =>
        snapshot.provider === "CLAUDE" &&
        (snapshot.provenance?.sourceKind === "statusline_payload" ||
          ((snapshot.provenance === undefined || snapshot.provenance === null) &&
            snapshot.source === "native_payload")) &&
        freshness(snapshot.observedAt, snapshot.expiresAt, now) === "fresh",
    );
    const failureByProvider = new Map(
      failures.map((failure) => [failure.provider, failure.category]),
    );

    if (!initialTabDetermined) {
      initialTabDetermined = true;
      const connectionsRes = await listConnections();
      const connList = connectionsRes.ok ? normalizeConnectionList(connectionsRes.value) : [];
      const hasConnections =
        connList.length > 0 ||
        snapshots.some((s) => freshness(s.observedAt, s.expiresAt, now) !== "unknown");
      if (hasConnections) {
        selectTab(0);
      } else {
        selectTab(1);
      }
    }

    /*
     * A card per provider that has something to say, and no card at all for a
     * provider that has nothing.
     *
     * This window used to draw all six on every launch, so a fresh install
     * opened on a wall of empty outlines that read as six broken connections
     * rather than as a tool nobody has pointed at anything yet. The providers
     * with no reading are named in one quiet line under the grid instead.
     */
    elements.cards.textContent = "";
    const carded = PROVIDER_CODES.filter(
      (provider) =>
        snapshots.some((snapshot) => snapshot.provider === provider) ||
        failureByProvider.has(provider),
    );
    for (const provider of carded) {
      elements.cards.append(
        card(
          provider,
          snapshots.filter((snapshot) => snapshot.provider === provider),
          now,
          failureByProvider.get(provider) ?? null,
        ),
      );
    }

    /* A failure is worth showing even when it left nothing readable behind. */
    const nothing = snapshots.length === 0 && failures.length === 0;
    elements.empty.hidden = !nothing;
    elements.cards.hidden = nothing;

    const context = buildAgentContext(advice);
    elements.context.textContent = context === ""
      ? "Nothing. Every provider is unknown, and silence beats a block full of guesses."
      : context;
    elements.statusline.textContent = renderClaudeStatusline(advice);

    const reason = advice.inject ? advice.reason : "UNKNOWN";
    elements.reasonCode.textContent = reason;
    elements.stateDot.dataset.pressure = REASON_PRESSURE[reason];

    const recommendation = advice.recommendation;
    if (recommendation.code === "PREFER") {
      elements.recChip.className = "chip accent";
      elements.recChip.hidden = false;
      elements.recCode.textContent = "PREFER " + recommendation.provider;
      elements.recDetail.textContent = recommendation.reason;
    } else {
      elements.recChip.hidden = true;
    }

    elements.stamp.textContent = "as of " + new Date().toLocaleTimeString();

    const tray = trayText(advice);
    await setTrayStatus(tray);
    /* The Claude card's ready or collecting split reads the cache through
       the flag set above, so it is told the cache moved. */
    noteMetersRefreshed();
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

void stateDirectory().then((result) => {
  const directory = result.ok ? result.value : null;
  elements.where.textContent = directory === null
    ? "No state directory could be resolved on this system."
    : "Reading " + directory;
});

/* ----------------------------------------------------------- provider connect */

function setCardNote(node, text, tone) {
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone ?? "plain";
}

/**
 * What a test that never reached a parse looks like.
 *
 * Every field stated, because the absent ones were the bug: `snapshots` used to
 * be missing on these paths, and the caller asked `snapshots !== null`, which
 * `undefined` satisfies. A refused probe therefore reported a parsed test.
 */
const NOTHING_TESTED = { ok: false, snapshots: null, drifted: false, generation: null };

async function testConnectionHelper(connectionId) {
  const result = await testProvider({ connectionId });
  if (!result.ok) {
    if (result.reason === BACKEND_ABSENT) {
      return { ...NOTHING_TESTED, note: "This build has no connection backend yet." };
    }
    return { ...NOTHING_TESTED, note: result.message };
  }
  const outcome = normalizeCollectionOutcome(result.value);
  return {
    ...NOTHING_TESTED,
    ok: outcome.kind === "tested",
    note: outcome.succeeded ? null : outcome.message,
  };
}

async function handleConnectSubmit({ providerId, credentialKind, aliasInputId, keyInputId, submitBtnId, noteElId }) {
  const input = document.getElementById(keyInputId);
  const aliasInput = document.getElementById(aliasInputId);
  const noteEl = document.getElementById(noteElId);
  const submitBtn = document.getElementById(submitBtnId);

  if (!input || !submitBtn || !noteEl) return;

  const secret = input.value.trim();
  input.value = "";

  if (secret === "") {
    setCardNote(noteEl, "Nothing was pasted, so nothing was stored.", "bad");
    return;
  }

  const alias = aliasInput ? (aliasInput.value.trim() || "default") : "default";
  submitBtn.disabled = true;
  setCardNote(noteEl, "Storing the credential in the credential store.", "plain");

  const connected = await connectProvider({
    providerId,
    credentialKind,
    accountAlias: alias,
    secret,
  });

  if (!connected.ok) {
    if (connected.reason === BACKEND_ABSENT) {
      setCardNote(noteEl, "This build has no connection backend yet.", "bad");
    } else {
      setCardNote(noteEl, "Connecting failed. " + connected.message, "bad");
    }
    submitBtn.disabled = false;
    return;
  }

  setCardNote(noteEl, "Stored. Testing the connection now.", "plain");
  const connectionId = typeof connected.value === "string"
    ? connected.value
    : (normalizeConnection(connected.value)?.id ?? null);

  const listRes = await listConnections();
  let record = null;
  if (listRes.ok) {
    const connections = normalizeConnectionList(listRes.value);
    record = (connectionId !== null
      ? connections.find((e) => e.id === connectionId)
      : undefined) ?? connections.filter((e) => e.provider === providerId.toUpperCase()).at(-1);
  }

  const targetId = record ? record.id : connectionId;
  if (!targetId) {
    setCardNote(noteEl, "The credential was stored, and no connection record came back to test.", "bad");
    submitBtn.disabled = false;
    connectionsTabShown();
    return;
  }

  const tested = await testConnectionHelper(targetId);
  const freshListRes = await listConnections();
  let settledState = null;
  if (freshListRes.ok) {
    const connections = normalizeConnectionList(freshListRes.value);
    const settled = connections.find((e) => e.id === targetId);
    if (settled) settledState = settled.state;
  }

  if (tested.note !== null) {
    setCardNote(noteEl, "The test failed. " + tested.note, "bad");
  } else {
    const sentence = settledState ? (connectionSentence[settledState] || settledState) : "Connected.";
    setCardNote(
      noteEl,
      "Test finished. " + sentence,
      tested.ok === true ? "ok" : "bad"
    );
  }

  if (aliasInput) aliasInput.value = "";
  submitBtn.disabled = false;
  connectionsTabShown();
}

function updateConnectSectionVisibility() {
  listConnections().then((result) => {
    const absent = !result.ok && result.reason === BACKEND_ABSENT;
    for (const id of ["codex-add", "antigravity-add", "opencode-add"]) {
      const el = document.getElementById(id);
      if (el) {
        el.hidden = absent;
      }
    }
  });
}

/**
 * The honesty labels, read from the generated registry and from nowhere else.
 *
 * They used to be hard coded here AND in index.html, which is how two of them
 * ended up printing only UNVERIFIED while their connectors also claimed
 * official-local-tool, internal-endpoint and high, and how OpenCode's frozen
 * value `high` became the softer prose "high automation risk". Four exact wire
 * words per provider, in a fixed order, or nothing at all: a provider the
 * registry does not describe gets no chips rather than reassuring ones.
 */
const HONESTY_LABELS_BY_PROVIDER = (() => {
  const byProvider = {};
  const providers = Array.isArray(PROVIDER_SPECS?.providers)
    ? PROVIDER_SPECS.providers
    : [];
  for (const entry of providers) {
    const honesty = entry?.honesty;
    if (honesty === undefined || honesty === null) continue;
    const code = String(honesty.connectorId ?? "").toUpperCase();
    if (code === "") continue;
    byProvider[code] = [
      honesty.verification,
      honesty.credentialOrigin,
      honesty.dataInterfaceStatus,
      honesty.automationRisk,
    ].filter((word) => typeof word === "string" && word !== "");
  }
  return byProvider;
})();

/**
 * Fill every static honesty placeholder from the generated registry.
 *
 * The connect sections carry an empty container and a provider attribute; the
 * words come from here. Idempotent, so a re render cannot double the chips.
 */
function fillStaticHonestyLabels() {
  document.querySelectorAll("[data-honesty-provider]").forEach((node) => {
    const provider = node.dataset.honestyProvider ?? "";
    const labels = HONESTY_LABELS_BY_PROVIDER[provider];
    if (labels === undefined) return;
    node.replaceChildren();
    for (const label of labels) {
      const chip = document.createElement("span");
      chip.className = "chip muted";
      chip.textContent = label;
      node.appendChild(chip);
    }
  });
}

fillStaticHonestyLabels();

function decorateConnectionCardsHonestyLabels() {
  const cardElements = document.querySelectorAll("#connections-cards .conn-card");
  cardElements.forEach((cardNode) => {
    const nameEl = cardNode.querySelector(".card-id .name");
    const headEl = cardNode.querySelector(".conn-head");
    if (!nameEl || !headEl) return;
    const nameText = nameEl.textContent.trim().toUpperCase();
    let providerKey = null;
    if (nameText.includes("CODEX")) providerKey = "CODEX";
    else if (nameText.includes("ANTIGRAVITY")) providerKey = "ANTIGRAVITY";
    else if (nameText.includes("OPENCODE")) providerKey = "OPENCODE";
    else if (nameText.includes("OPENROUTER")) providerKey = "OPENROUTER";

    if (providerKey && HONESTY_LABELS_BY_PROVIDER[providerKey]) {
      if (!cardNode.querySelector(".card-honesty-labels")) {
        const labelsContainer = document.createElement("div");
        labelsContainer.className = "card-honesty-labels honesty-labels";
        HONESTY_LABELS_BY_PROVIDER[providerKey].forEach((label) => {
          const chip = document.createElement("span");
          chip.className = "chip muted";
          chip.textContent = label;
          labelsContainer.appendChild(chip);
        });
        headEl.appendChild(labelsContainer);
      }
    }
  });
}

/* The Connections tab. It owns the collector tick, the connection cards, the
   OpenRouter connect flow and the Claude Code enable card, and it borrows
   from this file only the four small facts it cannot know itself. */
initConnections({
  providerName: (code) => PROVIDER_NAMES[code] ?? code,
  markFor: (code) => MARKS[code] ?? "",
  onMetersChanged: () => {
    void refresh();
  },
  hasFreshLocalClaude: () => freshLocalClaude,
});

document.getElementById("codex-submit")?.addEventListener("click", () => {
  /* Codex is the one provider whose secret never crosses this window. The
     backend imports the token and the account identifier from the Codex login
     file on this machine and discards whatever the window sent, so the field
     is hidden and refilled here: the submit path clears it on every press, and
     an empty field would be refused before the import ever ran. */
  const codexField = document.getElementById("codex-key");
  if (codexField) codexField.value = "imported from the codex login file";
  void handleConnectSubmit({
    providerId: "codex",
    credentialKind: "codex_session",
    aliasInputId: "codex-alias",
    keyInputId: "codex-key",
    submitBtnId: "codex-submit",
    noteElId: "codex-note",
  });
});

document.getElementById("antigravity-submit")?.addEventListener("click", () => {
  void handleConnectSubmit({
    providerId: "antigravity",
    credentialKind: "antigravity_session",
    aliasInputId: "antigravity-alias",
    keyInputId: "antigravity-key",
    submitBtnId: "antigravity-submit",
    noteElId: "antigravity-note",
  });
});

document.getElementById("opencode-submit")?.addEventListener("click", () => {
  void handleConnectSubmit({
    providerId: "opencode",
    credentialKind: "opencode_browser_session",
    aliasInputId: "opencode-alias",
    keyInputId: "opencode-key",
    submitBtnId: "opencode-submit",
    noteElId: "opencode-note",
  });
});

updateConnectSectionVisibility();

const cardsContainer = document.getElementById("connections-cards");
if (cardsContainer) {
  const observer = new MutationObserver(() => {
    decorateConnectionCardsHonestyLabels();
  });
  observer.observe(cardsContainer, { childList: true, subtree: true });
}

void refresh();
window.setInterval(() => {
  void refresh();
}, REFRESH_INTERVAL);
