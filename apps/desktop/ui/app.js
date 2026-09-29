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
} from "./engine/core/index.js";
import { PROVIDER_SPECS } from "./provider-specs.generated.js";
/* The one projection, names and drawing Home shares with the edge panel. */
import {
  attentionFlags,
  connectedProviders,
  holdReadings,
  limitsModel,
  officialMark,
  projectReadings,
  renderLimits,
  updatedLabel,
} from "./readings.js";
import { meterLabel, providerName, say } from "./names.js";
/* The four screens the connection and entitlement contract asks for. Each one
   owns its own tab and reads the backend itself, so a failure in one leaves
   the other three drawing what they can prove. */
import { renderPlanCap } from "./plan-cap.js";
import { ALERTS_EN, renderSettings, refreshDesktopTrial, tickDesktopTrial } from "./settings.js";
import { mountAgents } from "./agents.js";
import { renderPro, renderSpend } from "./pro.js";
/* The phone panel and the device list it produces. Both live behind an
   account, and both are drawn by their own module rather than here. */
import {
  initPairing,
  pairingPanelClosed,
  pairingPanelOpened,
  renderDevices,
  setPairingAccountState,
} from "./pairing.js";
/* Every sentence the sign in can say, in a module that imports nothing. */
import {
  CREATING_ACCOUNT,
  REOPEN_AFTER_MILLISECONDS,
  REOPEN_FAILED,
  SIGNED_IN_DWELL_MILLISECONDS,
  SIGNING_IN,
  openingSentence,
  signInFailureSentence,
  signInFailureTone,
  signedInSentence,
} from "./sign-in-states.js";
/* Every word the Rust process hears from this file goes through the backend
   adapter, so a build without a given command degrades to an honest absence
   instead of a module level crash, and a static serve of these files renders
   the empty state rather than nothing at all. */
import {
  BACKEND_ABSENT,
  accountEmail,
  accountLogout,
  accountOauth,
  accountOauthReopen,
  claudePollEnabled,
  codexDeviceLoginCancel,
  codexDeviceLoginStart,
  codexDeviceLoginStatus,
  setClaudePollEnabled,
  setProviderEnabled,
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
  refreshHome,
  readManual,
  notificationEvents,
  notificationGate,
  proCheckoutUrl,
  proDisconnect,
  proRefresh,
  setTrayStatus,
  testProvider,
} from "./backend.js";
import { readConfiguredProviders, readRemovedProviders, adoptDetectedProviders } from "./configured-providers.js";
import { bindHomeRefresh, paintObserved } from "./home-refresh.js";
import { headerPopovers } from "./header-popovers.js";
import { homeProviders } from "./home-state.js";
/* Every value on a failure card came off a file this window did not write, so
   the card is built out of nodes and text rather than out of a markup string. */
import { buildFailureRow } from "./failure-rows.js";
import {
  connectionsTabShown,
  initConnections,
  noteMetersRefreshed,
  openCatalogue,
  openProviderConnection,
  showConnections,
} from "./connections.js";
import { initFirstRun, claudePollRow } from "./first-run.js";
import { initWhatsNew } from "./whats-new.js";

/** How often the window re reads the cache, in milliseconds. */
const REFRESH_INTERVAL = 30_000;

/** Where the theme choice is kept, matching the key the site's toggle uses. */
const THEME_KEY = "openlimiter-theme";

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
    mark.innerHTML = officialMark(provider);
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
  menuSignIn: document.getElementById("menu-signin"),
  menuSignInButton: document.getElementById("menu-sign-in"),
  menuSignedIn: document.getElementById("menu-signed-in"),
  phoneButton: document.getElementById("phone-button"),
  phonePopover: document.getElementById("phone-popover"),
  notificationGate: document.getElementById("notification-gate"),
  notificationUpgrade: document.getElementById("notification-upgrade"),
  signIn: document.getElementById("sign-in"),
  signInSlot: document.getElementById("sign-in-slot"),
  signInBody: document.getElementById("sign-in-body"),
  signInClose: document.getElementById("sign-in-close"),
  signInStatus: document.getElementById("sign-in-status"),
  signInStatusText: document.getElementById("sign-in-status-text"),
  signInEmailStatus: document.getElementById("sign-in-email-status"),
  signInEmailStatusText: document.getElementById("sign-in-email-status-text"),
  signInReopen: document.getElementById("account-oauth-reopen"),
  signInSuccess: document.querySelector("#sign-in-body .sign-in-success"),
  signInSuccessText: document.getElementById("sign-in-success-text"),
  signInToggle: document.getElementById("account-email-toggle"),
  signInEmail: document.getElementById("account-email"),
  signInPassword: document.getElementById("account-password"),
  signInForm: document.getElementById("account-email-form"),
  signInSubmit: document.getElementById("account-email-sign-in"),
  signInCreate: document.getElementById("account-email-create"),
  signInGoogle: document.getElementById("account-google"),
  signInGithub: document.getElementById("account-github"),
  updateBanner: document.getElementById("update-banner"),
  offlineBanner: document.getElementById("offline-banner"),
  addAccount: document.getElementById("add-account"),
  emptyConnect: document.getElementById("empty-connect"),
  observed: document.getElementById("home-observed"),
  refreshStatus: document.getElementById("home-refresh-status"),
  failures: document.getElementById("failures"),
  loading: document.getElementById("loading"),
  planCapMount: document.getElementById("plan-cap-mount"),
  planCapPlan: document.getElementById("plan-cap-plan"),
  spendMount: document.getElementById("spend-mount"),
  proMount: document.getElementById("pro-mount"),
  settingsMount: document.getElementById("settings-mount"),
  agentsMount: document.getElementById("agents-mount"),
  railSettingsMount: document.getElementById("rail-settings-mount"),
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

/*
 * Whether the tray should still be offering a trial.
 *
 * Held here because the entitlement is read here, and the tray menu is drawn
 * by Rust from what this window tells it. It starts as offered, which is the
 * honest answer before anything has been read, and the first plan read past
 * this point settles it. A menu that keeps offering a trial to somebody
 * already paying reads as an advertisement rather than as a control.
 */
let trialOffered = true;

async function paintPlanBadge() {
  const result = await proStatus();
  const plan = result.ok ? (result.value?.plan_state ?? "free") : "free";
  trialOffered = plan !== "active" && plan !== "trial";
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
  openCatalogue();
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
  popovers.close();
}

/** Whether a session exists right now. The sign in card and the phone panel
    both branch on it, so it has one owner and is read rather than guessed. */
let signedIn = false;

function applyAccountState(status) {
  if (status === null || typeof status !== "object") return;
  signedIn = status.signedIn === true;
  elements.menuEmail.textContent = signedIn
    ? String(status.email ?? "Signed in")
    : "Signed out";
  elements.menuBackend.textContent =
    status.backendReachable === false && signedIn ? "Cached session" : "";
  elements.menuSync.checked = status.syncEnabled !== false;
  elements.offlineBanner.hidden = !(signedIn && status.backendReachable === false);
  /* Signed out, the menu offers the card instead of a switch that has nothing
     to switch and a log out that has nothing to end. */
  if (elements.menuSignIn !== null) elements.menuSignIn.hidden = signedIn;
  if (elements.menuSignedIn !== null) elements.menuSignedIn.hidden = !signedIn;
  if (elements.menuLogout !== null) elements.menuLogout.hidden = !signedIn;
  setPairingAccountState(signedIn);
  void refreshDesktopTrial();
}

/* ------------------------------------------------------------- signing in */

/**
 * One sign in body, two hosts.
 *
 * The body, the two provider buttons with their marks, the rule, the email
 * form behind its quiet link and the status line, is one set of nodes. The
 * sheet owns it; the first run account step borrows it for the length of
 * that step and hands it back, so there is exactly one password field in the
 * document and one place for a sign in bug to live.
 *
 * Every state the body can be in is drawn rather than printed: a browser tab
 * opening, the service refusing a provider it has not switched on, a session
 * arriving, an account waiting on its confirmation email. The sentences come
 * from sign-in-states.js; this file only decides when each one is shown.
 */
function signInControls() {
  return [
    elements.signInGithub,
    elements.signInGoogle,
    elements.signInToggle,
    elements.signInEmail,
    elements.signInPassword,
    elements.signInSubmit,
    elements.signInCreate,
  ].filter((control) => control !== null);
}

/** Whether a sign in is in flight. One at a time, whichever button started it. */
let signInBusy = false;

/** The control that started the attempt in flight. It carries the spinner. */
let signInPressed = null;

/** The timer that offers the browser link again once a tab has had its time. */
let signInReopenTimer = null;

/* Two status rows, one under the provider buttons and one under the email
   form, so an answer lands right under the control that asked for it. A
   provider's refusal never opens the form and never lands inside it. */
function statusRegion(slot) {
  return slot === "email"
    ? { row: elements.signInEmailStatus, text: elements.signInEmailStatusText }
    : { row: elements.signInStatus, text: elements.signInStatusText };
}

function clearSignInStatus(slot) {
  const region = statusRegion(slot);
  region.row?.removeAttribute("data-tone");
  if (region.text !== null) region.text.textContent = "";
}

/** The status line: a tone and a sentence in one row, the other row cleared. */
function setSignInStatus(tone, text, slot = "provider") {
  clearSignInStatus(slot === "email" ? "provider" : "email");
  if (tone === null) {
    clearSignInStatus(slot);
    return;
  }
  const region = statusRegion(slot);
  if (region.row === null) return;
  region.row.dataset.tone = tone;
  if (region.text !== null) region.text.textContent = text;
}

/* While an attempt is in flight the pressed control keeps its fill and shows
   the spinner, and everything else in the body steps back to seventy percent
   rather than greying out. */
function setSignInBusy(busy, pressed = null) {
  signInBusy = busy;
  signInPressed?.removeAttribute("data-working");
  signInPressed = busy ? pressed : null;
  signInPressed?.setAttribute("data-working", "true");
  elements.signInBody?.setAttribute("aria-busy", busy ? "true" : "false");
  for (const control of signInControls()) control.disabled = busy;
}

function offerReopen(show) {
  if (elements.signInReopen !== null) elements.signInReopen.hidden = !show;
}

function stopReopenTimer() {
  if (signInReopenTimer !== null) window.clearTimeout(signInReopenTimer);
  signInReopenTimer = null;
  offerReopen(false);
}

/* The email form is the quieter path. It waits behind its link and takes the
   link's place when asked for, so the two never sit on screen together. It
   opens from that link and from nowhere else: a failure elsewhere in the
   body says its sentence where it is and leaves the form alone. */
function showEmailForm(open) {
  if (elements.signInForm !== null) elements.signInForm.hidden = !open;
  if (elements.signInToggle !== null) {
    elements.signInToggle.hidden = open;
    elements.signInToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (open) elements.signInEmail?.focus();
}

/* The arrival. The body gives way to one check and the address, with nothing
   live underneath it. The row under the providers has no tone now, so it has
   no size on screen and keeps its place in the accessibility tree: the
   sentence is announced from there while the check is what is seen. */
function showSignedIn(sentence) {
  if (elements.signInBody === null) return;
  setSignInStatus(null, "");
  elements.signInBody.dataset.state = "signed-in";
  if (elements.signInSuccess !== null) elements.signInSuccess.hidden = false;
  if (elements.signInSuccessText !== null) elements.signInSuccessText.textContent = sentence;
  if (elements.signInStatusText !== null) elements.signInStatusText.textContent = sentence;
}

/** The body at rest: nothing said, the form put away, every control live. */
function resetSignInBody() {
  stopReopenTimer();
  setSignInBusy(false);
  setSignInStatus(null, "");
  showEmailForm(false);
  if (elements.signInBody !== null) delete elements.signInBody.dataset.state;
  if (elements.signInSuccess !== null) elements.signInSuccess.hidden = true;
  if (elements.signInPassword instanceof HTMLInputElement) {
    elements.signInPassword.value = "";
  }
}

function signInIsInSheet() {
  return elements.signInBody?.parentElement === elements.signInSlot;
}

/** Lend the body to another host, the first run account step. */
function mountSignIn(host) {
  if (elements.signInBody === null || !(host instanceof HTMLElement)) return;
  host.append(elements.signInBody);
  resetSignInBody();
  elements.signInGithub?.focus();
}

/** Take the body back into the sheet, wherever it was. */
function unmountSignIn() {
  if (elements.signInBody === null || elements.signInSlot === null) return;
  if (!signInIsInSheet()) elements.signInSlot.append(elements.signInBody);
  resetSignInBody();
}

function openSignIn() {
  if (elements.signIn === null) return;
  closeHeaderPopovers();
  unmountSignIn();
  elements.signIn.hidden = false;
  elements.signInGithub?.focus();
}

function closeSignIn() {
  if (elements.signIn === null) return;
  elements.signIn.hidden = true;
  resetSignInBody();
}

/**
 * Run one sign in to its drawn end.
 *
 * `provider` is the OAuth provider the attempt is about, or null for the
 * email form, and it is what lets a refusal be worded for the button that
 * was pressed. A success has its moment on screen before the body is put
 * away, and only then is the arrival announced to the window, so first run
 * finishes on a drawn state rather than on a dialog that vanished mid
 * sentence.
 */
async function runSignIn(action, provider, working, pressed) {
  if (signInBusy) return { ok: false, kind: "oauth_busy", displayed: false };
  const slot = provider === null ? "email" : "provider";
  setSignInBusy(true, pressed);
  setSignInStatus("working", working, slot);
  if (provider !== null) {
    /* A browser tab gets its time. After that the link is offered again, for
       a tab that was closed or lost, and only while the attempt still waits. */
    signInReopenTimer = window.setTimeout(() => {
      signInReopenTimer = null;
      if (signInBusy) offerReopen(true);
    }, REOPEN_AFTER_MILLISECONDS);
  }
  const result = await action();
  stopReopenTimer();
  if (!result.ok || result.value?.signedIn !== true) {
    setSignInBusy(false);
    setSignInStatus(signInFailureTone(result), signInFailureSentence(result, provider), slot);
    /* `displayed` tells a caller that drew its own button that the refusal is
       already on screen, so the same sentence does not land twice. */
    return { ...result, ok: false, displayed: true };
  }
  applyAccountState(result.value);
  if (result.value.syncEnabled !== false) {
    void accountSyncConfiguredSnapshot(readConfiguredProviders());
  }
  setSignInBusy(false);
  showSignedIn(signedInSentence(result.value.email));
  void refresh();
  window.setTimeout(() => {
    if (signInIsInSheet()) closeSignIn();
    window.dispatchEvent(new CustomEvent("openlimiter:signed-in"));
  }, SIGNED_IN_DWELL_MILLISECONDS);
  return { ok: true, displayed: true };
}

/**
 * One way in, whichever button was pressed and wherever it was drawn.
 *
 * GitHub and Google are buttons in the shared body; Microsoft is drawn by the
 * first run step, which hands its own element in so the busy state lands on
 * the control somebody actually pressed. All three reach `runSignIn`, which is
 * what applies the account state, draws the arrival and announces it. A path
 * that skips it signs somebody in and leaves the screen where it was.
 */
function continueWith(provider, pressed = null) {
  const known = { google: elements.signInGoogle, github: elements.signInGithub };
  const control = pressed ?? known[provider] ?? elements.signInGithub;
  return runSignIn(() => accountOauth(provider), provider, openingSentence(provider), control);
}

function emailInput() {
  return {
    email: elements.signInEmail?.value ?? "",
    password: elements.signInPassword?.value ?? "",
  };
}

elements.signInClose?.addEventListener("click", closeSignIn);
elements.menuSignInButton?.addEventListener("click", openSignIn);

/* Not now, the backdrop and Escape all put the sheet away, mid flight too: a
   provider sign in can sit for minutes on a browser tab and nobody is held
   in a dialog for it. An attempt already talking to the service still lands;
   a session that arrives late is applied to the window all the same, and a
   second attempt started meanwhile is answered by the broker as busy. */
elements.signIn?.addEventListener("click", (event) => {
  if (event.target === elements.signIn) closeSignIn();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || elements.signIn === null || elements.signIn.hidden) return;
  closeSignIn();
});

elements.signInToggle?.addEventListener("click", () => showEmailForm(true));

/* The link again, for a tab that was closed or lost. The attempt in flight
   keeps waiting either way; only the browser is asked to open once more. */
elements.signInReopen?.addEventListener("click", () => {
  void accountOauthReopen().then((result) => {
    if (!result.ok) setSignInStatus("error", REOPEN_FAILED);
  });
});

elements.signInForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void runSignIn(
    () => accountEmail({ ...emailInput(), create: false }),
    null,
    SIGNING_IN,
    elements.signInSubmit,
  );
});

elements.signInCreate?.addEventListener("click", () => {
  /* Create account is not the form's submit, so the form's own checks are
     asked for by hand: the same address and password rules, the same
     browser messages, before anything is sent. */
  if (elements.signInForm instanceof HTMLFormElement && !elements.signInForm.reportValidity()) {
    return;
  }
  void runSignIn(
    () => accountEmail({ ...emailInput(), create: true }),
    null,
    CREATING_ACCOUNT,
    elements.signInCreate,
  );
});

elements.signInGithub?.addEventListener("click", () => void continueWith("github"));
elements.signInGoogle?.addEventListener("click", () => void continueWith("google"));

function eventSentence(event) {
  const subject = providerName(event.provider) + " " + meterLabel(event.windowName, event.provider).toLowerCase();
  if (event.kind === "reset") {
    return subject + " reset.";
  }
  const threshold = String(event.kind ?? "").replace("threshold_", "");
  return subject + " reached " + threshold + " percent.";
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

/* Ask once per window when the native backend is available.
   Local desktop alerts are free, with or without an account. */
let permissionAsked = false;

async function requestAlertPermission(notification = globalThis.Notification) {
  if (notification === undefined || typeof notification.requestPermission !== "function") {
    return "unsupported";
  }
  if (notification.permission === "granted") return "granted";
  if (notification.permission === "denied") return "denied";
  try {
    return await notification.requestPermission();
  } catch (error) {
    return "unsupported";
  }
}

function permissionSentence(outcome) {
  if (outcome === "granted") {
    return "Alerts are on. You can change the thresholds or set quiet hours in Settings.";
  }
  if (outcome === "denied") {
    return "The operating system is holding alerts. Every meter still works, and the system settings can undo this later.";
  }
  if (outcome === "skipped") {
    return "Skipped. Alerts can be turned on in Settings whenever you want them.";
  }
  return "This build cannot show system alerts, so nothing was asked for. The meters are unaffected.";
}

async function paintAlertGate() {
  if (elements.notificationGate === null) return;
  const result = await notificationGate();
  const entitled = result.ok && result.value?.entitled === true;
  elements.notificationGate.hidden = entitled;
  if (!entitled || permissionAsked) return;
  permissionAsked = true;
  const outcome = await requestAlertPermission();
  if (outcome === "granted") return;
  const note = document.getElementById("notification-gate-note");
  if (note === null) return;
  elements.notificationGate.hidden = false;
  const title = document.getElementById("notification-gate-title");
  if (title !== null) title.textContent = ALERTS_EN.localFreeTitle;
  note.textContent = permissionSentence(outcome);
  elements.notificationUpgrade?.setAttribute("hidden", "");
}

elements.notificationUpgrade?.addEventListener("click", () => {
  void openCheckout("monthly");
});

const popovers = headerPopovers([
  { panel: elements.notificationPopover, button: elements.bell, onOpen() {
    void renderNotificationEvents();
    void paintAlertGate();
  } },
  { panel: elements.phonePopover, button: elements.phoneButton,
    onOpen: pairingPanelOpened, onClose: pairingPanelClosed },
  { panel: elements.menu, button: elements.menuButton, onOpen() {
    if (signedIn) void renderDevices();
  } },
]);

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

/**
 * Send a person to hosted Checkout, in their own browser.
 *
 * Rust opens the address the server returned, so nothing about a price or a
 * session is assembled here. Coming back to this window refreshes the
 * entitlement, which is why a completed purchase shows within seconds rather
 * than at the next hourly refresh.
 */
async function openCheckout(plan) {
  if (!signedIn) {
    openSignIn();
    return;
  }
  const result = await proCheckoutUrl(plan);
  if (result.ok) return;
  const note = document.getElementById("notification-gate-note");
  if (note !== null) {
    note.textContent = result.message ?? "Checkout could not be opened.";
  }
}

/* A purchase happens in a browser, so the window learns about it by coming
   back into focus. Refreshing then is the difference between "it worked" and
   "restart the app". */
window.addEventListener("focus", () => {
  if (!signedIn) return;
  void refreshDesktopTrial();
  void proRefresh().then(() => {
    void paintPlanBadge();
  });
});

window.setInterval(tickDesktopTrial, 60_000);

/* ------------------------------------------------------------------ reading */

/**
 * Everything displayable on this machine right now, what cannot be shown, and
 * what was lost getting it.
 *
 * read_cache hands over rows the native data rules already projected, with the
 * flags for everything they held back; the manual document never passed through
 * native code. Both go through projectReadings, the one projection Home shares
 * with the edge panel, so a hidden row has no side door back onto this screen.
 * A file that is simply absent is not a failure: this window is often opened
 * before anything has written a cache at all.
 */
async function collect(now) {
  const cacheRead = await readCache();
  if (!cacheRead.ok && cacheRead.reason !== BACKEND_ABSENT) {
    throw new Error("The cached readings could not be read.");
  }
  const manualRead = await readManual();
  return projectReadings(cacheRead.ok ? cacheRead.value : null, manualRead.ok ? manualRead.value : null, now);
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

let refreshing = null;
let selectedHomeProviders = [];
/* The rows on screen, held so a failed read can age them out by the one
   freshness policy rather than leave them frozen. */
let heldSnapshots = [];

/**
 * Whether a fresh Claude reading that arrived through the local statusline is
 * in the cache right now. The Connections tab reads this to tell "ready to
 * collect" apart from "collecting": the wiring being present is one fact, a
 * payload actually flowing is another, and only the cache knows the second.
 */
let freshLocalClaude = false;

/** One alert per failed provider, in the core's own sentence. */
function paintFailures(failures) {
  if (elements.failures === null) return;
  const rows = dedupeFailures(failures);
  elements.failures.hidden = rows.length === 0;
  /* Nodes, not a markup string. The category came off a file this window did
     not write, and a category with no sentence shows its own words. */
  elements.failures.replaceChildren(
    ...rows.map((failure) =>
      buildFailureRow(
        providerName(failure.provider),
        /* A fixed table, not a function. The core keeps one sentence per
           category so no surface can invent a variation of its own. */
        failureSentence[failure.category] ?? failure.category,
      ),
    ),
  );
}

function refresh() {
  if (refreshing) return refreshing;
  refreshing = repaintHome().finally(() => { refreshing = null; });
  return refreshing;
}

async function repaintHome() {
  /* Shown until the first collect answers, then never again: a second wait is
     a repaint of numbers already on screen and must not blank them. */
  if (elements.loading !== null && !painted.has("first")) {
    elements.loading.hidden = false;
    painted.add("first");
  }
  try {
    const now = new Date().toISOString();
    const [collected, detectionResult, connectionResult, pollResult] = await Promise.all([
      collect(now), listDetectedProviders(), listConnections(), claudePollEnabled(),
    ]);
    const detections = detectionResult.ok ? detectionResult.value : null;
    const connections = connectionResult.ok ? normalizeConnectionList(connectionResult.value) : [];
    adoptDetectedProviders(detections);
    const removed = readRemovedProviders();
    /* Displayable rows only: the active account, fresh by the one freshness
       policy, measured. A provider a person removed stays off Home even if a
       writer still reports it. */
    const visible = collected.snapshots.filter((snapshot) => !removed.includes(snapshot.provider));
    const configuredProviders = homeProviders(readConfiguredProviders(), detections, connections, visible, removed);
    selectedHomeProviders = configuredProviders;
    const pollEnabled = pollResult.ok ? pollResult.value === true : null;
    const pollMount = document.getElementById("claude-poll-control");
    if (pollMount && !pollMount.querySelector("input:disabled")) {
      pollMount.replaceChildren(claudePollRow(
        { setClaudePoll: setClaudePollEnabled }, pollEnabled,
        () => void refresh(), "connection-claude-poll",
      ));
    }
    const visibleFailures = collected.failures.filter((failure) =>
      configuredProviders.includes(failure.provider)
    );
    const advice = buildAdvice(visible, now, configuredProviders);
    freshLocalClaude = visible.some(
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
      if (connList.length > 0 || visible.length > 0) {
        selectTab(TAB_METERS);
      } else {
        selectTab(TAB_CONNECTIONS);
      }
    }

    heldSnapshots = visible;
    paintLimits(visible, now);
    if (elements.refreshStatus?.textContent === say("cacheUnreadable")) elements.refreshStatus.textContent = "";
    paintFailures(visibleFailures);
    const attention = attentionFlags(collected.flags, collected.snapshots, removed);
    showConnections({
      attention,
      connected: connectedProviders({ snapshots: visible, detections, connections, flags: collected.flags, removed, attention }),
    });

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
      trialOffered,
    });
    /* The Claude card's ready or collecting split reads the cache through
       the flag set above, so it is told the cache moved. */
    noteMetersRefreshed();
    return true;
  } catch (error) {
    /* A failed read keeps only what is still fresh of the rows already on
       screen, by the same freshness policy, and says why in one sentence. The
       tray is asked to redraw too: it reads the cache itself. */
    const now = new Date().toISOString();
    heldSnapshots = holdReadings(heldSnapshots, now);
    paintLimits(heldSnapshots, now);
    if (elements.refreshStatus) elements.refreshStatus.textContent = say("cacheUnreadable");
    await setTrayStatus({ providers: [], trialOffered });
    return false;
  }
}

/** Draw Home's limits, or its empty card, from displayable rows. */
function paintLimits(snapshots, now) {
  const model = limitsModel(snapshots, now);
  renderLimits(document, elements.rows, model);
  if (elements.loading !== null) elements.loading.hidden = true;
  elements.empty.hidden = model.length > 0;
  elements.rows.hidden = model.length === 0;
  paintObserved(elements.observed, snapshots, (instant) => updatedLabel(instant, now));
}

bindHomeRefresh({
  button: document.getElementById("home-refresh"),
  status: document.getElementById("home-refresh-status"),
  readNow: async () => {
    await refresh();
    return refreshHome(selectedHomeProviders);
  },
  repaint: async () => {
    if (refreshing) await refreshing;
    return refresh();
  },
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
   from this file only the three small facts it cannot know itself. */
initConnections({
  markFor: officialMark,
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

const disposeAgents = mountAgents(elements.agentsMount, { markFor: officialMark });
window.addEventListener("beforeunload", disposeAgents, { once: true });

initPairing({ onSignIn: openSignIn });

void initWhatsNew().catch(() => {
  // Release notes must not prevent startup if the local resource is unavailable.
});

initFirstRun({
  setProviderEnabled,
  accountStatus,
  detectProviders: listDetectedProviders,
  markFor: officialMark,
  isSignedIn: () => signedIn,
  mountSignIn,
  unmountSignIn,
  /* Step one hands the wire value straight through, so the one place that
     owns sign in stays the one place that owns sign in. */
  signInWithProvider: (wire, pressed) => continueWith(wire, pressed),
  /* Step two's install rows show a command rather than running one. The
     clipboard is the whole of the help this product offers there. */
  copyText: async (text) => {
    try {
      await navigator.clipboard.writeText(String(text));
      return { ok: true };
    } catch (error) {
      /* A webview with no clipboard permission is a fact, not a failure: the
         line is on screen and can be selected by hand. */
      return { ok: false };
    }
  },
  claudePollEnabled,
  setClaudePoll: (enabled) => setClaudePollEnabled(enabled),
  codexSignIn: codexDeviceLoginStart,
  codexSignInPoll: codexDeviceLoginStatus,
  codexSignInCancel: codexDeviceLoginCancel,
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
