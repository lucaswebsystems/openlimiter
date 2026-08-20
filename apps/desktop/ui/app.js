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
 * boundary anywhere else. Network traffic is limited to provider reads a
 * person explicitly connected and optional Pro sync after sign in.
 */
import {
  PROVIDER_CODES,
  buildAdvice,
  connectionSentence,
  dedupeFailures,
  freshness,
  mergeSnapshots,
  normalizeMetersReport,
  readSuppressions,
  visibleSnapshots,
} from "./engine/core/index.js";
import { PROVIDER_SPECS } from "./provider-specs.generated.js";
import { parseManualPayload } from "./engine/connectors/manual.js";
import {
  buildAgentContext,
  renderClaudeStatusline,
} from "./engine/adapters/claude-code.js";
import {
  buildProviderAccountRows,
  createProviderRowElement,
} from "./engine/ui/provider-row.js";
/* Every word the Rust process hears from this file goes through the backend
   adapter, so a build without a given command degrades to an honest absence
   instead of a module level crash, and a static serve of these files renders
   the empty state rather than nothing at all. */
import {
  BACKEND_ABSENT,
  connectProvider,
  listDetectedProviders,
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
  connectionsTabShown,
  initConnections,
  noteMetersRefreshed,
  openProviderConnection,
} from "./connections.js";
import { initFirstRun } from "./first-run.js";

/** How often the window re reads the cache, in milliseconds. */
const REFRESH_INTERVAL = 30_000;

const PROVIDER_NAMES = {
  CLAUDE: "Claude",
  OPENROUTER: "OpenRouter",
  CODEX: "Codex",
  GROK: "Grok (xAI)",
  KIMI: "Kimi",
  ANTIGRAVITY: "Antigravity",
  GEMINI_CLI: "Gemini CLI",
  OPENCODE: "OpenCode",
  MANUAL: "Manual",
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
  GEMINI_CLI: FILLED_OPEN + '<path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
  CODEX:
    FILLED_OPEN +
    '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  GROK:
    STROKED_OPEN +
    '<path d="M5 4l14 16M19 4 5 20M8 4h11M5 20h11"/></svg>',
  KIMI:
    STROKED_OPEN +
    '<path d="M6 4v16M18 4 7 13M11 10l8 10"/></svg>',
  MANUAL:
    STROKED_OPEN +
    '<path d="M16.6 3.6a2 2 0 0 1 2.8 2.8L8.5 17.3l-3.7.9.9-3.7Z"/>' +
    '<path d="m14.6 5.6 3.8 3.8M4 21h16"/></svg>',
};

const PROVIDER_HEADS = {
  "claude-card-title": "CLAUDE",
  "openrouter-add-title": "OPENROUTER",
  "codex-add-title": "CODEX",
  "antigravity-add-title": "ANTIGRAVITY",
  "opencode-add-title": "OPENCODE",
};

function decorateProviderHeads() {
  for (const [headingId, provider] of Object.entries(PROVIDER_HEADS)) {
    const heading = document.getElementById(headingId);
    if (heading === null) continue;
    const head = heading.closest(".conn-head");
    if (head === null || head.querySelector(".conn-provider-mark")) continue;
    const title = document.createElement("span");
    title.className = "conn-title";
    const mark = document.createElement("span");
    mark.className = "conn-provider-mark";
    mark.dataset.provider = provider;
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = MARKS[provider] ?? "";
    head.insertBefore(title, head.firstChild);
    title.append(mark, heading);
  }
}

decorateProviderHeads();

/* The same sentences apps/web/app/app/language.ts renders, word for word,
   with the % sign the reference uses rather than the word. */
const REASON_PRESSURE = {
  HEALTHY: "ok",
  NEAR_CAP: "high",
  AT_CAP: "critical",
  UNKNOWN: "none",
};

const elements = {
  rows: document.getElementById("provider-rows"),
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
  addAccount: document.getElementById("add-account"),
  emptyConnect: document.getElementById("empty-connect"),
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

function beginAddAccount() {
  selectTab(1, true);
  const panel = document.getElementById("panel-connections");
  panel?.setAttribute("data-adding", "");
  window.setTimeout(() => panel?.removeAttribute("data-adding"), 1200);
  window.requestAnimationFrame(() => {
    const target = document.querySelector("#catalogue-rows .catalogue-action button");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  });
}

elements.addAccount?.addEventListener("click", beginAddAccount);
elements.emptyConnect?.addEventListener("click", beginAddAccount);

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
    for (const provider of report.rejected) {
      failures.push({ provider, category: "VALIDATION_REJECTED" });
    }
    const suppressionRead = readSuppressions(cached.suppressions);
    if (suppressionRead.ok) {
      fromCache = visibleSnapshots({
        snapshots: report.snapshots,
        suppressions: suppressionRead.suppressions,
      });
      for (const suppression of suppressionRead.suppressions) {
        failures.push({ provider: suppression.provider, category: "PROVIDER_DRIFT" });
      }
    } else {
      /* An unreadable suppression list cannot prove any cached row is still
         trustworthy. Keep every named provider visible as unknown. */
      for (const provider of new Set(report.snapshots.map((row) => row.provider))) {
        failures.push({ provider, category: "PROVIDER_DRIFT" });
      }
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

/** One bounded percentage per provider for the native tray menu. */
function trayProviders(advice) {
  const byProvider = new Map(
    advice.providers.map((entry) => [entry.provider, entry.usagePercent]),
  );
  return PROVIDER_CODES.map((provider) => ({
    provider,
    usage_percent: byProvider.get(provider) ?? null,
  }));
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

    elements.rows.textContent = "";
    const providerRows = buildProviderAccountRows(snapshots, now, failures);
    for (const row of providerRows) {
      elements.rows.append(createProviderRowElement(row));
    }

    elements.empty.hidden = true;
    elements.rows.hidden = false;

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
      elements.recCode.textContent = "NEXT " + recommendation.provider;
      elements.recDetail.textContent = recommendation.reason;
    } else {
      elements.recChip.hidden = true;
    }

    elements.stamp.textContent = new Date().toLocaleTimeString();

    await setTrayStatus({ providers: trayProviders(advice) });
    /* The Claude card's ready or collecting split reads the cache through
       the flag set above, so it is told the cache moved. */
    noteMetersRefreshed();
  } catch {
    elements.stamp.textContent = "Cache unavailable";
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
    else if (nameText.includes("GEMINI CLI")) providerKey = "GEMINI_CLI";
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

const cardsContainer = document.getElementById("connections-cards");
if (cardsContainer) {
  const observer = new MutationObserver(() => {
    decorateConnectionCardsHonestyLabels();
  });
  observer.observe(cardsContainer, { childList: true, subtree: true });
}

initFirstRun({
  detectProviders: listDetectedProviders,
  markFor: (code) => MARKS[code] ?? "",
  onContinue: () => {
    void refresh();
  },
  onInstall: (provider) => {
    selectTab(1, true);
    openProviderConnection(provider);
  },
});

void refresh();
window.setInterval(() => {
  void refresh();
}, REFRESH_INTERVAL);
