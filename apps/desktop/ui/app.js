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
  buildAdvice,
  connectionSentence,
  dedupeFailures,
  failureSentence,
  freshness,
  mergeSnapshots,
  normalizeMetersReport,
  readSuppressions,
  visibleSnapshots,
} from "./engine/core/index.js";
import { PROVIDER_SPECS } from "./provider-specs.generated.js";
import { parseManualPayload } from "./engine/connectors/manual.js";
import {
  bandForPercent,
  buildProviderAccountRows,
  createProviderRowElement,
} from "./engine/ui/provider-row.js";
/* The four screens the connection and entitlement contract asks for. Each one
   owns its own tab and reads the backend itself, so a failure in one leaves
   the other three drawing what they can prove. */
import { defineLiveMeter } from "./live-meter.js";
import { renderPlanCap } from "./plan-cap.js";
import { renderSettings } from "./settings.js";
import { renderPro, renderSpend } from "./pro.js";
/* Every word the Rust process hears from this file goes through the backend
   adapter, so a build without a given command degrades to an honest absence
   instead of a module level crash, and a static serve of these files renders
   the empty state rather than nothing at all. */
import {
  BACKEND_ABSENT,
  accountEmail,
  accountLogout,
  accountOauth,
  accountSetSync,
  accountStatus,
  accountSyncConfiguredSnapshot,
  checkForUpdate,
  connectProvider,
  evaluateNotifications,
  installUpdate,
  listDetectedProviders,
  listConnections,
  normalizeCollectionOutcome,
  normalizeConnection,
  normalizeConnectionList,
  proStatus,
  readCache,
  readManual,
  notificationEvents,
  proDisconnect,
  setTrayStatus,
  testProvider,
} from "./backend.js";
import { readConfiguredProviders } from "./configured-providers.js";
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
 * this bundle, at 24 units. Provider colours resolve from the shared token
 * sheet, while Antigravity and Gemini retain their official gradients.
 *
 * Manual entry is not a company at all and keeps its own glyph: a person
 * writing a number down.
 *
 * These strings are constants. Nothing read off disk ever reaches innerHTML.
 */
const FILLED_OPEN =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">';

const STROKED_OPEN =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
  'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

const MARKS = {
  CLAUDE:
    FILLED_OPEN +
    '<path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  OPENROUTER:
    FILLED_OPEN +
    '<path d="M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z"/></svg>',
  OPENCODE: FILLED_OPEN + '<path d="M22 24H2V0h20zM17 4.8H7v14.4h10z"/></svg>',
  ANTIGRAVITY:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<defs><linearGradient id="ol-antigravity-gradient" x1="12" y1="1.8" x2="12" y2="22.4" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="var(--ol-provider-google-red)"/>' +
    '<stop offset=".34" stop-color="var(--ol-provider-google-yellow)"/>' +
    '<stop offset=".66" stop-color="var(--ol-provider-google-green)"/>' +
    '<stop offset="1" stop-color="var(--ol-provider-google-blue)"/></linearGradient></defs>' +
    '<path d="M12 1.8C14.8 1.8 17.1 7.8 19.6 14.2C20.5 16.5 21.4 19 21.4 20.2C21.4 21.8 19.8 22.4 17.8 20.6C16.3 16.8 14.1 12.5 12 12.5C9.9 12.5 7.7 16.8 6.2 20.6C4.2 22.4 2.6 21.8 2.6 20.2C2.6 19 3.5 16.5 4.4 14.2C6.9 7.8 9.2 1.8 12 1.8Z" fill="url(#ol-antigravity-gradient)"/></svg>',
  GEMINI_CLI:
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
    '<defs><linearGradient id="ol-gemini-gradient" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="var(--ol-provider-gemini-blue)"/>' +
    '<stop offset=".52" stop-color="var(--ol-provider-gemini-purple)"/>' +
    '<stop offset="1" stop-color="var(--ol-provider-gemini-coral)"/></linearGradient></defs>' +
    '<path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" fill="url(#ol-gemini-gradient)"/></svg>',
  CODEX:
    FILLED_OPEN +
    '<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  GROK:
    FILLED_OPEN +
    '<path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>',
  KIMI:
    FILLED_OPEN +
    '<path d="M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441"/></svg>',
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

const elements = {
  rows: document.getElementById("provider-rows"),
  empty: document.getElementById("empty"),
  theme: document.getElementById("theme"),
  bell: document.getElementById("notification-bell"),
  notificationPopover: document.getElementById("notification-popover"),
  notificationEvents: document.getElementById("notification-events"),
  menuButton: document.getElementById("menu-button"),
  menu: document.getElementById("app-menu"),
  menuEmail: document.getElementById("menu-account-email"),
  menuBackend: document.getElementById("menu-backend-state"),
  menuSync: document.getElementById("menu-sync"),
  menuUpdate: document.getElementById("menu-update"),
  menuLogout: document.getElementById("menu-logout"),
  updateBanner: document.getElementById("update-banner"),
  offlineBanner: document.getElementById("offline-banner"),
  addAccount: document.getElementById("add-account"),
  emptyConnect: document.getElementById("empty-connect"),
  hero: document.getElementById("hero"),
  heroMeter: document.getElementById("hero-meter"),
  heroObserved: document.getElementById("hero-observed"),
  staleStrip: document.getElementById("stale-strip"),
  staleStripText: document.getElementById("stale-strip-text"),
  failures: document.getElementById("failures"),
  loading: document.getElementById("loading"),
  planCapMount: document.getElementById("plan-cap-mount"),
  planCapPlan: document.getElementById("plan-cap-plan"),
  spendMount: document.getElementById("spend-mount"),
  proMount: document.getElementById("pro-mount"),
  settingsMount: document.getElementById("settings-mount"),
  tabs: [
    document.getElementById("tab-meters"),
    document.getElementById("tab-spend"),
    document.getElementById("tab-connections"),
    document.getElementById("tab-settings"),
  ],
  panels: [
    document.getElementById("panel-meters"),
    document.getElementById("panel-spend"),
    document.getElementById("panel-connections"),
    document.getElementById("panel-settings"),
  ],
};

defineLiveMeter();

/* The first paint of a tab is deferred until it is opened. A window that
   builds four screens before showing one is a window that opens slowly. */
const painted = new Set();

async function paintTab(id) {
  if (id === "tab-connections") {
    await renderPlanCap(elements.planCapMount, { onChange: () => void refresh() });
    await paintPlanBadge();
    painted.add(id);
    return;
  }
  if (id === "tab-spend") {
    await renderSpend(elements.spendMount);
    painted.add(id);
    return;
  }
  if (id === "tab-settings") {
    await renderPro(elements.proMount);
    await renderSettings(elements.settingsMount);
    painted.add(id);
  }
}

async function paintPlanBadge() {
  const result = await proStatus();
  const plan = result.ok ? (result.value?.plan_state ?? "free") : "free";
  if (elements.planCapPlan === null) return;
  const names = {
    free: "Free",
    active: "Pro",
    trial: "Trial",
    past_due: "Payment failed",
    canceled: "Ending",
  };
  elements.planCapPlan.textContent = names[plan] ?? plan;
  if (plan === "active" || plan === "trial") {
    elements.planCapPlan.setAttribute("data-tone", "accent");
  } else {
    elements.planCapPlan.removeAttribute("data-tone");
  }
}

/* -------------------------------------------------------------------- tabs */

let initialTabDetermined = false;

/* The strip is four wide now, so a caller names the tab and never the number.
   A position typed as a literal is a position that goes wrong the next time a
   tab is added between two others. */
const TAB_METERS = 0;
const TAB_CONNECTIONS = 2;

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
  const id = elements.tabs[index]?.id;
  if (id !== undefined && id !== "tab-meters") void paintTab(id);
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
  selectTab(TAB_CONNECTIONS, true);
  const panel = document.getElementById("panel-connections");
  panel?.setAttribute("data-adding", "");
  window.setTimeout(() => panel?.removeAttribute("data-adding"), 1200);
  window.requestAnimationFrame(() => {
    const target = document.querySelector(
      "#catalogue-rows .catalogue-action button"
    );
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  });
}

elements.addAccount?.addEventListener("click", beginAddAccount);
elements.emptyConnect?.addEventListener("click", beginAddAccount);

/* ------------------------------------------------ account, menu and alerts */

function closeHeaderPopovers() {
  elements.notificationPopover.hidden = true;
  elements.menu.hidden = true;
  elements.bell.setAttribute("aria-expanded", "false");
  elements.menuButton.setAttribute("aria-expanded", "false");
}

function applyAccountState(status) {
  if (status === null || typeof status !== "object") return;
  elements.menuEmail.textContent = status.signedIn
    ? String(status.email ?? "Signed in")
    : "Signed out";
  elements.menuBackend.textContent =
    status.backendReachable === false && status.signedIn
      ? "Cached session"
      : "";
  elements.menuSync.checked = status.syncEnabled !== false;
  elements.offlineBanner.hidden = !(
    status.signedIn && status.backendReachable === false
  );
}

function eventSentence(event) {
  if (event.kind === "reset") {
    return event.provider + " " + event.windowName + " reset.";
  }
  const threshold = String(event.kind ?? "").replace("threshold_", "");
  return (
    event.provider +
    " " +
    event.windowName +
    " reached " +
    threshold +
    " percent."
  );
}

async function renderNotificationEvents() {
  const result = await notificationEvents();
  const events = result.ok && Array.isArray(result.value) ? result.value : [];
  elements.notificationEvents.textContent = "";
  if (events.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No recent notifications.";
    elements.notificationEvents.append(empty);
    return;
  }
  for (const event of events.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "notification-event";
    row.textContent = eventSentence(event);
    elements.notificationEvents.append(row);
  }
}

async function runUpdateCheck(silent) {
  if (!silent) elements.menuUpdate.textContent = "Checking for updates";
  const result = await checkForUpdate();
  if (!result.ok) {
    if (!silent)
      elements.menuUpdate.textContent =
        result.message ?? "Update check unavailable";
    return;
  }
  if (result.value === null) {
    if (!silent) elements.menuUpdate.textContent = "OpenLimiter is current";
    return;
  }
  const version = String(result.value.version ?? "new version");
  elements.updateBanner.textContent =
    "OpenLimiter " + version + " is ready. Install now.";
  elements.updateBanner.hidden = false;
  elements.menuUpdate.textContent = "Install OpenLimiter " + version;
}

elements.bell?.addEventListener("click", () => {
  const opening = elements.notificationPopover.hidden;
  closeHeaderPopovers();
  elements.notificationPopover.hidden = !opening;
  elements.bell.setAttribute("aria-expanded", opening ? "true" : "false");
  if (opening) void renderNotificationEvents();
});

elements.menuButton?.addEventListener("click", () => {
  const opening = elements.menu.hidden;
  closeHeaderPopovers();
  elements.menu.hidden = !opening;
  elements.menuButton.setAttribute("aria-expanded", opening ? "true" : "false");
});

document.addEventListener("click", (event) => {
  if (
    event.target instanceof Node &&
    !event.target.parentElement?.closest(".strip")
  ) {
    closeHeaderPopovers();
  }
});

elements.menuSync?.addEventListener("change", () => {
  const requested = elements.menuSync.checked;
  void accountSetSync(requested).then((result) => {
    if (result.ok) applyAccountState(result.value);
    else elements.menuSync.checked = !requested;
  });
});

elements.menuUpdate?.addEventListener("click", () => {
  void runUpdateCheck(false);
});

elements.updateBanner?.addEventListener("click", () => {
  elements.updateBanner.disabled = true;
  elements.updateBanner.textContent = "Installing update";
  void installUpdate().then((result) => {
    if (!result.ok) {
      elements.updateBanner.disabled = false;
      elements.updateBanner.textContent =
        result.message ?? "Update install unavailable";
    }
  });
});

elements.menuLogout?.addEventListener("click", () => {
  void (async () => {
    await proDisconnect();
    const result = await accountLogout();
    if (result.ok) window.location.reload();
  })();
});

void accountStatus().then((result) => {
  if (result.ok) applyAccountState(result.value);
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
        failures.push({
          provider: suppression.provider,
          category: "PROVIDER_DRIFT",
        });
      }
    } else {
      /* An unreadable suppression list cannot prove any cached row is still
         trustworthy. Keep every named provider visible as unknown. */
      for (const provider of new Set(
        report.snapshots.map((row) => row.provider)
      )) {
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
function trayProviders(advice, configuredProviders) {
  const byProvider = new Map(
    advice.providers.map((entry) => [entry.provider, entry.usagePercent])
  );
  return configuredProviders.map((provider) => ({
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

/**
 * The one window that most deserves the instrument.
 *
 * "Most pressed" is the highest live percentage, and a stale reading never
 * wins it. An old ninety is not more urgent than a current eighty, it is only
 * louder, and putting it in the hero would be the window shouting a number it
 * has already stopped believing.
 */
function heroWindow(rows) {
  let best = null;
  for (const row of rows) {
    for (const window of row.windows) {
      if (window.usedPercent === null) continue;
      if (window.state !== "fresh") continue;
      if (best === null || window.usedPercent > best.window.usedPercent) {
        best = { row, window };
      }
    }
  }
  return best;
}

function paintHero(rows, now) {
  if (elements.hero === null || elements.heroMeter === null) return;
  const best = heroWindow(rows);
  if (best === null) {
    elements.hero.hidden = true;
    return;
  }
  elements.hero.hidden = false;
  elements.heroMeter.meter = {
    windowName: best.window.label,
    accountLabel: best.row.showAccountLabel ? best.row.accountLabel : best.row.providerLabel,
    usedPercent: best.window.usedPercent,
    band: bandForPercent(best.window.usedPercent),
    live: true,
    resetAt: bestResetAt(best.row, best.window),
  };
  if (elements.heroObserved !== null) {
    elements.heroObserved.textContent = new Date(now).toLocaleTimeString();
  }
}

/* The view carries a rendered countdown but not the instant behind it, and the
   instrument needs the instant so it can tick. It is read back off the
   snapshot the row was built from. */
let resetInstants = new Map();

function bestResetAt(row, window) {
  return resetInstants.get(row.provider + "::" + (row.accountId ?? "") + "::" + window.key) ?? null;
}

function rememberResets(snapshots) {
  resetInstants = new Map();
  for (const snapshot of snapshots) {
    if (typeof snapshot.resetAt !== "string") continue;
    resetInstants.set(
      snapshot.provider + "::" + (snapshot.accountId ?? "") + "::" + snapshot.meter,
      snapshot.resetAt
    );
  }
}

/**
 * The stale strip, which exists so a screen full of hatched bars is explained
 * once rather than eight times. It only appears when nothing on screen is
 * live, because a mix of fresh and stale rows already says which is which.
 */
function paintStaleStrip(rows) {
  if (elements.staleStrip === null) return;
  const drawn = rows.flatMap((row) => row.windows);
  const anyLive = drawn.some((window) => window.state === "fresh");
  const anyStale = drawn.some((window) => window.state !== "fresh");
  elements.staleStrip.hidden = anyLive || !anyStale || drawn.length === 0;
  if (elements.staleStripText !== null && !elements.staleStrip.hidden) {
    elements.staleStripText.textContent =
      "Nothing on screen is a live reading. Every bar below is hatched and shows the last number that was observed, not the number now.";
  }
}

/** One alert per failed provider, in the core's own sentence. */
function paintFailures(failures) {
  if (elements.failures === null) return;
  const rows = dedupeFailures(failures);
  elements.failures.hidden = rows.length === 0;
  elements.failures.innerHTML = rows
    .map((failure) => {
      /* A fixed table, not a function. The core keeps one sentence per
         category so no surface can invent a variation of its own, and a
         category with no entry shows its own code rather than nothing. */
      const sentence = failureSentence[failure.category] ?? failure.category;
      return (
        '<div class="alert" role="status"><strong>' +
        String(PROVIDER_NAMES[failure.provider] ?? failure.provider) +
        "</strong><p>" +
        String(sentence) +
        "</p></div>"
      );
    })
    .join("");
}

async function refresh() {
  if (refreshing) return;
  /* Shown until the first collect answers, then never again: a second wait is
     a repaint of numbers already on screen and must not blank them. */
  if (elements.loading !== null && !painted.has("first")) {
    elements.loading.hidden = false;
    painted.add("first");
  }
  refreshing = true;
  try {
    const now = new Date().toISOString();
    const { snapshots, failures } = await collect(now);
    const configuredProviders = readConfiguredProviders();
    const visible = snapshots.filter((snapshot) =>
      configuredProviders.includes(snapshot.provider)
    );
    const visibleFailures = failures.filter((failure) =>
      configuredProviders.includes(failure.provider)
    );
    const advice = buildAdvice(visible, now, configuredProviders);
    freshLocalClaude = snapshots.some(
      (snapshot) =>
        snapshot.provider === "CLAUDE" &&
        (snapshot.provenance?.sourceKind === "statusline_payload" ||
          ((snapshot.provenance === undefined ||
            snapshot.provenance === null) &&
            snapshot.source === "native_payload")) &&
        freshness(snapshot.observedAt, snapshot.expiresAt, now) === "fresh"
    );
    if (!initialTabDetermined) {
      initialTabDetermined = true;
      const connectionsRes = await listConnections();
      const connList = connectionsRes.ok
        ? normalizeConnectionList(connectionsRes.value)
        : [];
      const hasConnections =
        connList.length > 0 ||
        snapshots.some(
          (s) => freshness(s.observedAt, s.expiresAt, now) !== "unknown"
        );
      if (hasConnections) {
        selectTab(TAB_METERS);
      } else {
        selectTab(TAB_CONNECTIONS);
      }
    }

    elements.rows.textContent = "";
    rememberResets(visible);
    const providerRows = buildProviderAccountRows(
      visible,
      now,
      visibleFailures,
      { providers: configuredProviders }
    ).filter((row) => row.windows.length > 0);
    for (const row of providerRows) {
      elements.rows.append(createProviderRowElement(row));
    }

    if (elements.loading !== null) elements.loading.hidden = true;
    elements.empty.hidden = providerRows.length > 0;
    elements.rows.hidden = providerRows.length === 0;
    paintHero(providerRows, now);
    paintStaleStrip(providerRows);
    paintFailures(visibleFailures);

    const notificationSamples = visible
      .filter(
        (snapshot) =>
          snapshot.unit === "PERCENT" && Number.isFinite(snapshot.value)
      )
      .map((snapshot) => ({
        accountId: snapshot.accountId ?? "default",
        provider: snapshot.provider,
        meter: "provider_usage_percent",
        windowName: snapshot.meter,
        windowId: snapshot.resetAt ?? `meter:${snapshot.meter}`,
        windowIsAuthoritative: snapshot.resetAt !== null && snapshot.resetAt !== undefined,
        value: snapshot.value,
        observedAt: snapshot.observedAt,
      }));
    if (notificationSamples.length > 0) {
      const result = await evaluateNotifications(notificationSamples);
      if (result.ok && Array.isArray(result.value) && result.value.length > 0) {
        await renderNotificationEvents();
      }
    }

    await setTrayStatus({
      providers: trayProviders(advice, configuredProviders),
    });
    /* The Claude card's ready or collecting split reads the cache through
       the flag set above, so it is told the cache moved. */
    noteMetersRefreshed();
  } catch (error) {
    /* A failed refresh leaves the last valid provider rows untouched, which
       is the right behaviour and was also, for a while, a place a real bug
       went to die. The reason is surfaced now: an interface that cannot say
       why it stopped updating is one nobody can debug from a screenshot. */
    if (elements.loading !== null) elements.loading.hidden = true;
    paintFailures([{ provider: "MANUAL", category: "PAYLOAD_UNREADABLE" }]);
  } finally {
    refreshing = false;
  }
}

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
  elements.theme.setAttribute(
    "aria-pressed",
    next === "dark" ? "true" : "false"
  );
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* Storage refused. The choice still applies to this window. */
  }
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
const NOTHING_TESTED = {
  ok: false,
  snapshots: null,
  drifted: false,
  generation: null,
};

async function testConnectionHelper(connectionId) {
  const result = await testProvider({ connectionId });
  if (!result.ok) {
    if (result.reason === BACKEND_ABSENT) {
      return {
        ...NOTHING_TESTED,
        note: "This build has no connection backend yet.",
      };
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

async function handleConnectSubmit({
  providerId,
  credentialKind,
  aliasInputId,
  keyInputId,
  submitBtnId,
  noteElId,
}) {
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

  const alias = aliasInput ? aliasInput.value.trim() || "default" : "default";
  submitBtn.disabled = true;
  setCardNote(
    noteEl,
    "Storing the credential in the credential store.",
    "plain"
  );

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
  const connectionId =
    typeof connected.value === "string"
      ? connected.value
      : normalizeConnection(connected.value)?.id ?? null;

  const listRes = await listConnections();
  let record = null;
  if (listRes.ok) {
    const connections = normalizeConnectionList(listRes.value);
    record =
      (connectionId !== null
        ? connections.find((e) => e.id === connectionId)
        : undefined) ??
      connections.filter((e) => e.provider === providerId.toUpperCase()).at(-1);
  }

  const targetId = record ? record.id : connectionId;
  if (!targetId) {
    setCardNote(
      noteEl,
      "The credential was stored, and no connection record came back to test.",
      "bad"
    );
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
    const sentence = settledState
      ? connectionSentence[settledState] || settledState
      : "Connected.";
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
  const cardElements = document.querySelectorAll(
    "#connections-cards .conn-card"
  );
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
  accountStatus,
  accountEmail,
  accountOauth,
  detectProviders: listDetectedProviders,
  markFor: (code) => MARKS[code] ?? "",
  onAccountState: (status) => {
    applyAccountState(status);
    if (status.syncEnabled !== false) {
      void accountSyncConfiguredSnapshot(readConfiguredProviders());
    }
  },
  onContinue: () => {
    void refresh();
  },
  onInstall: (provider) => {
    selectTab(TAB_CONNECTIONS, true);
    openProviderConnection(provider);
  },
});

void refresh();
void runUpdateCheck(true);
window.addEventListener("openlimiter:providers-changed", () => {
  void accountSyncConfiguredSnapshot(readConfiguredProviders());
  void refresh();
});
window.setInterval(() => {
  void refresh();
}, REFRESH_INTERVAL);
