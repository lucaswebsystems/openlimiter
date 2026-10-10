/**
 * The OpenLimiter window: one screen.
 *
 * It reads the same snapshot cache the command line tool writes, runs it
 * through the same engine the command line tool runs, and renders the result.
 * Every rule applied here, what a valid meter is, when a reading goes stale,
 * which provider is under the most pressure, comes out of packages/core,
 * packages/connectors and packages/adapters as compiled. Nothing about quota
 * is decided in this file.
 *
 * The screen is one list of tools, built from the provider inventory (every
 * tool detected, connected, keyed or flagged, plus Claude Code, Antigravity
 * and OpenRouter always), each with its bars or one step; then one row per
 * API key; then the agents while any run. Settings, the plan, the account and
 * the links live in the menu. There are no tabs: everything is mounted when
 * the window starts (Lucas, 2026-10-01).
 *
 * Rust sits behind ./backend.js for everything this file cannot do itself.
 * Network traffic is limited to provider reads a person explicitly connected
 * and optional Pro sync after sign in.
 */
import {
  buildAdvice,
  dedupeFailures,
  failureSentence,
  freshness,
} from "./engine/core/index.js";
/* The one projection, names and drawing Home shares with the edge panel. */
import {
  ALWAYS_LISTED,
  alertSamples,
  fixWords,
  holdReadings,
  inventoryModel,
  limitsKey,
  officialMark,
  patchLimits,
  projectReadings,
  renderLimits,
  splitInventory,
} from "./readings.js";
import { providerCode, providerName, say } from "./names.js";
import { renderPlanCap } from "./plan-cap.js";
import { refreshDesktopTrial, renderSettings, themeLabel, tickDesktopTrial } from "./settings.js";
import { mountAgents } from "./agents.js";
import { keyRepaintGate, keyRows, proEntitled, refreshEntitlement, renderKeys, renderPro, saveOpenrouterConnection } from "./pro.js";
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
   the screen with every tool's step rather than nothing at all. */
import {
  BACKEND_ABSENT,
  accountEmail,
  accountLogout,
  accountOauth,
  accountOauthReopen,
  accountSetSync,
  accountStatus,
  accountSyncConfiguredSnapshot,
  apiSpendRefresh,
  apiSpendRemoveSource,
  apiSpendSaveSource,
  apiSpendStatus,
  checkForUpdate,
  claudePollEnabled,
  codexDeviceLoginCancel,
  codexDeviceLoginStart,
  codexDeviceLoginStatus,
  evaluateNotifications,
  installUpdate,
  listConnections,
  listDetectedProviders,
  normalizeConnectionList,
  notificationGate,
  proDisconnect,
  proStatus,
  readCache,
  readManual,
  refreshHome,
  setClaudePollEnabled,
  setProviderEnabled,
  setTrayStatus,
  setTerminalCaptions,
} from "./backend.js";
import { readConfiguredProviders, readRemovedProviders, adoptDetectedProviders, homeSelectionControl } from "./configured-providers.js";
import { bindHomeRefresh } from "./home-refresh.js";
import { headerPopovers } from "./header-popovers.js";
import { homeProviders } from "./home-state.js";
/* Every value on a failure card came off a file this window did not write, so
   the card is built out of nodes and text rather than out of a markup string. */
import { buildFailureRow } from "./failure-rows.js";
import {
  catalogueModel,
  checkTool,
  chooseTool,
  claudeRuntimeNotice,
  claudeState,
  connectTool,
  initConnections,
  noteMetersRefreshed,
  placeSetupPanels,
  recordsFor,
  refreshConnection,
  removeConnection,
  replaceOpenrouterKey,
  saveOpenrouterKey,
} from "./connections.js";
import { initFirstRun } from "./first-run.js";
import { useClaudeSignIn } from "./claude-sign-in.js";
import { initWhatsNew, openWhatsNew } from "./whats-new.js";
import { tabSwitcher } from "./tabs.js";

/** How often the window re reads the cache, in milliseconds. */
const REFRESH_INTERVAL = 30_000;

/** Where the theme choice is kept, matching the key the site's toggle uses. */
const THEME_KEY = "openlimiter-theme";

const elements = {
  usageRows: document.getElementById("usage-rows"),
  usageEmpty: document.getElementById("usage-empty"),
  usageConnect: document.getElementById("usage-connect"),
  spendSection: document.getElementById("spend-section"),
  spendRows: document.getElementById("spend-rows"),
  toolRows: document.getElementById("tool-rows"),
  addTool: document.getElementById("add-tool"),
  catalogue: document.getElementById("tool-catalogue"),
  keyRows: document.getElementById("key-rows"),
  agentsSection: document.getElementById("agents-section"),
  agentsMount: document.getElementById("agents-mount"),
  theme: document.getElementById("theme"),
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
  refreshStatus: document.getElementById("home-refresh-status"),
  failures: document.getElementById("failures"),
  loading: document.getElementById("loading"),
  planCapMount: document.getElementById("plan-cap-mount"),
  proMount: document.getElementById("pro-mount"),
  settingsMount: document.getElementById("settings-appearance"),
};

/*
 * Whether the tray should still be offering a trial.
 *
 * Held here because the entitlement is read here, and the tray menu is drawn
 * by Rust from what this window tells it. It starts as offered, which is the
 * honest answer before anything has been read, and the first plan read past
 * this point settles it.
 */
let trialOffered = true;

async function readPlan() {
  const result = await proStatus();
  const pro = result.ok ? result.value : null;
  const entitled = proEntitled(pro);
  trialOffered = !entitled;
  if (result.ok && pro?.theme_preset !== true) {
    const reset = await setTerminalCaptions("short");
    return { ...result, captionsReset: reset.ok };
  }
  return { ...result, captionsReset: true };
}

/* ------------------------------------------------ account, menu and alerts */

function closeHeaderPopovers() {
  popovers.close();
}

/** Whether a session exists right now. The menu and the phone panel both
    branch on it, so it has one owner and is read rather than guessed. */
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
  /* Signed out, the menu offers Sign in instead of a switch that has nothing
     to switch and a sign out that has nothing to end. */
  if (elements.menuSignIn !== null) elements.menuSignIn.hidden = signedIn;
  if (elements.menuSignedIn !== null) elements.menuSignedIn.hidden = !signedIn;
  if (elements.menuLogout !== null) elements.menuLogout.hidden = !signedIn;
  if (signedIn) void renderDevices();
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
  void refreshEntitlement();
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
/* The plan card repaints, so the button is reached by delegation. */
document.addEventListener("click", (event) => {
  /* Reconnect drops only this device's local Pro trust, so the next refresh
     registers a fresh device chain. Nothing is revoked: a revoke would bump
     the account epoch and sign the phone out. */
  if (event.target instanceof Element && event.target.closest("#pro-reconnect")) {
    void proDisconnect().then(() => refreshEntitlement());
  }
});

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

async function runUpdateCheck(silent) {
  if (!silent) elements.menuUpdate.textContent = "Checking for updates";
  const result = await checkForUpdate();
  if (!result.ok) {
    if (!silent) elements.menuUpdate.textContent = "Update check unavailable";
    return;
  }
  if (result.value === null) {
    if (!silent) elements.menuUpdate.textContent = "OpenLimiter is current";
    return;
  }
  const version = String(result.value.version ?? "new version");
  elements.updateBanner.textContent = "OpenLimiter " + version + " is ready. Install now.";
  elements.updateBanner.hidden = false;
  elements.menuUpdate.textContent = "Install OpenLimiter " + version;
}

/* Ask once per window, when the menu that holds the Alerts switch opens.
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

async function askAlertPermission() {
  const result = await notificationGate();
  const entitled = result.ok && result.value?.entitled === true;
  if (!entitled || permissionAsked) return;
  permissionAsked = true;
  await requestAlertPermission();
}

const popovers = headerPopovers([
  { panel: elements.phonePopover, button: elements.phoneButton,
    onOpen: pairingPanelOpened, onClose: pairingPanelClosed },
]);

const tabs = tabSwitcher({
  tabs: document.querySelectorAll('[role="tab"]'),
  panels: document.querySelectorAll('[role="tabpanel"]'),
  onSelect: (id) => {
    if (id === "tab-settings") void askAlertPermission();
  },
});

for (const node of document.querySelectorAll("[data-copy]")) {
  const value = say(node.getAttribute("data-copy"));
  if (value) node.textContent = value;
}
for (const node of document.querySelectorAll("[data-copy-aria]")) {
  const value = say(node.getAttribute("data-copy-aria"));
  if (value) {
    node.setAttribute("aria-label", value);
    node.setAttribute("title", value);
  }
}
elements.usageConnect?.addEventListener("click", () => tabs.select(document.getElementById("tab-tools")));
document.getElementById("pair-phone")?.addEventListener("click", (event) => {
  event.stopPropagation();
  elements.phoneButton?.click();
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
elements.menuWhatsNew = document.getElementById("menu-whats-new");
elements.menuWhatsNew?.addEventListener("click", () => { void openWhatsNew(); });

elements.updateBanner?.addEventListener("click", () => {
  elements.updateBanner.disabled = true;
  elements.updateBanner.textContent = "Installing update";
  void installUpdate().then((result) => {
    if (!result.ok) {
      elements.updateBanner.disabled = false;
      elements.updateBanner.textContent = "Update install unavailable";
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



/* A purchase happens in a browser, so the window learns about it by coming
   back into focus. Refreshing then is the difference between "it worked" and
   "restart the app". */
window.addEventListener("focus", () => {
  if (!signedIn) return;
  void refreshDesktopTrial();
  void refreshEntitlement();
});

/* The three Settings blocks, mounted only after entitlement normalization so a
   downgraded Tagged caption choice never paints for one frame. */
const mountPlanCap = () => renderPlanCap(elements.planCapMount, { onChange: () => void refresh() });
void (async () => {
  const plan = await readPlan();
  await renderPro(elements.proMount);
  if (plan.captionsReset !== false) await renderSettings(elements.settingsMount);
  await mountPlanCap();
})();

/* One refresh repaints every control gated on the entitlement: the tray
   offer, the account cap, the plan card and the preset. */
window.addEventListener("openlimiter:pro-changed", () => {
  void (async () => {
    const plan = await readPlan();
    await mountPlanCap();
    await renderPro(elements.proMount);
    if (plan.captionsReset !== false) await renderSettings(elements.settingsMount);
  })();
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
 * A file that is simply absent is not a failure.
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
/* Everything else the list was last drawn from, so a failed read redraws the
   same tools with only the readings aged. */
let inventory = { flags: [], detections: null, connections: [], removed: [] };
let spendStatus = null;
/* The direct Claude check setting: null until read, so no button flashes. */
let claudePoll = null;

/**
 * Whether a fresh Claude reading that arrived through the local statusline is
 * in the cache right now: the difference between Claude Code being set up
 * and collecting, and set up and waiting.
 */
let freshLocalClaude = false;

/** One alert per failed provider, in the core's own sentence. */
function paintFailures(failures) {
  if (elements.failures === null) return;
  const rows = dedupeFailures(failures);
  elements.failures.hidden = rows.length === 0;
  elements.failures.replaceChildren(
    ...rows.map((failure) =>
      buildFailureRow(
        providerName(failure.provider),
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
  if (elements.loading !== null && heldSnapshots.length === 0 && drawnTools === "") elements.loading.hidden = false;
  try {
    const now = new Date().toISOString();
    const [collected, detectionResult, connectionResult, spendResult, pollResult] = await Promise.all([
      collect(now), listDetectedProviders(), listConnections(), apiSpendStatus(), claudePollEnabled(),
    ]);
    claudePoll = pollResult.ok && typeof pollResult.value?.enabled === "boolean"
      ? pollResult.value.enabled
      : null;
    const detections = detectionResult.ok ? detectionResult.value : null;
    const connections = connectionResult.ok ? normalizeConnectionList(connectionResult.value) : [];
    adoptDetectedProviders(detections);
    const removed = readRemovedProviders();
    /* Displayable rows only: the active account, measured, fresh or held stale
       by the data rules. A provider a person removed stays off Home even if a
       writer still reports it. */
    const visible = collected.snapshots.filter((snapshot) => !removed.includes(snapshot.provider));
    const configuredProviders = homeProviders(readConfiguredProviders(), detections, connections, visible, removed);
    selectedHomeProviders = configuredProviders;
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

    heldSnapshots = visible;
    inventory = { flags: collected.flags, detections, connections, removed };
    spendStatus = spendResult.ok ? spendResult.value : null;
    paintTools(visible, now);
    paintKeys(now);
    if (elements.refreshStatus?.textContent === say("cacheUnreadable")) elements.refreshStatus.textContent = "";
    paintFailures(visibleFailures);

    const notificationSamples = alertSamples(visible, now);
    if (notificationSamples.length > 0) await evaluateNotifications(notificationSamples);

    await setTrayStatus({
      providers: trayProviders(advice, configuredProviders),
      trialOffered,
    });
    /* Claude Code's setup panel reads the cache through the flag set above. */
    noteMetersRefreshed();
    return true;
  } catch (error) {
    /* A failed read keeps what the data rules still draw of the rows already
       on screen (fresh, or stale with its age), and says why in one sentence. */
    const now = new Date().toISOString();
    heldSnapshots = holdReadings(heldSnapshots, now);
    paintTools(heldSnapshots, now);
    if (elements.refreshStatus) elements.refreshStatus.textContent = say("cacheUnreadable");
    await setTrayStatus({ providers: [], trialOffered });
    return false;
  }
}

/* ------------------------------------------------------------ the one list */

let drawnUsage = "";
let drawnTools = "";
let drawnCatalogue = "";
/* Which rows have their small menu open, kept across redraws. */
const openMenus = new Set();
let catalogueOpen = false;

const toolHandlers = {
  /* OpenRouter connects through its key row, so its Connect goes there. */
  connect: (code) => {
    document.getElementById("tab-tools")?.click();
    return code === "OPENROUTER" ? focusKey("openrouter") : connectTool(code);
  },
  check: (code) => checkTool(code),
  /* Claude's one click: the direct check on, the menu switch repainted, one read. */
  poll: async () => {
    const done = await useClaudeSignIn({
      setPoll: setClaudePollEnabled,
      repaintMenu: () => renderSettings(elements.settingsMount),
      check: checkTool,
    });
    claudePoll = done ? true : claudePoll;
    void refresh();
    return done;
  },
};

const catalogueHandlers = {
  connect: (code) => chooseTool(code, "connect"),
  check: (code) => chooseTool(code, "check"),
};

/** Draw the list from the inventory, and the catalogue of what is not in it. */
function paintTools(snapshots, now) {
  const model = inventoryModel({
    snapshots,
    flags: inventory.flags,
    detections: inventory.detections,
    connections: inventory.connections,
    configured: readConfiguredProviders(),
    removed: inventory.removed,
    claude: claudeState(),
    claudePoll,
  }, now);
  /* Redrawn only when something on it changed, so a step in flight keeps
     its button and its line. */
  const { usage, tools } = splitInventory(model);
  /* Under Claude's bars while the terminal runtime is older than this app. */
  const runtimeNotice = claudeRuntimeNotice();
  const usageKey = limitsKey(usage) + (runtimeNotice === null ? "" : "runtime notice");
  if (usageKey !== drawnUsage) {
    drawnUsage = usageKey;
    renderLimits(document, elements.usageRows, usage);
    if (runtimeNotice !== null) {
      elements.usageRows.querySelector('[data-provider-card][data-provider="CLAUDE"]')?.append(runtimeNotice);
    }
  } else {
    patchLimits(elements.usageRows, usage);
  }
  if (elements.usageEmpty !== null) elements.usageEmpty.hidden = usage.length !== 0;
  const key = limitsKey(tools);
  if (key !== drawnTools) {
    drawnTools = key;
    renderLimits(document, elements.toolRows, tools, { handlers: toolHandlers, more: fillMore, opened: openMenus });
  } else {
    patchLimits(elements.toolRows, tools);
  }
  placeSetupPanels();
  if (elements.loading !== null) elements.loading.hidden = true;
  const catalogue = catalogueModel(tools.map((tool) => tool.code));
  const catalogueKey = limitsKey(catalogue);
  if (catalogueKey !== drawnCatalogue) {
    drawnCatalogue = catalogueKey;
    renderLimits(document, elements.catalogue, catalogue, { handlers: catalogueHandlers });
  } else {
    patchLimits(elements.catalogue, catalogue);
  }
  elements.addTool.hidden = catalogue.length === 0;
  paintCatalogue();
}

function paintCatalogue() {
  const open = catalogueOpen && !elements.addTool.hidden;
  elements.catalogue.hidden = !open;
  elements.addTool.setAttribute("aria-expanded", String(open));
}

elements.addTool?.addEventListener("click", () => {
  catalogueOpen = !catalogueOpen;
  paintCatalogue();
});

/* A press of Remove that waits four seconds for its second press. */
function confirmButton(label, onConfirm) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "q-btn q-btn-ghost";
  button.textContent = label;
  let armed = null;
  button.addEventListener("click", async () => {
    if (armed === null) {
      button.textContent = say("removeConfirm");
      armed = window.setTimeout(() => {
        armed = null;
        button.textContent = label;
      }, 4_000);
      return;
    }
    window.clearTimeout(armed);
    armed = null;
    button.disabled = true;
    await onConfirm();
    button.disabled = false;
  });
  return button;
}

function moreLine(...children) {
  const line = document.createElement("div");
  line.className = "q-moreline";
  line.append(...children);
  return line;
}

function text(className, value) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = value;
  return span;
}

/**
 * A row's small menu: its switch, a fix for another account that needs one,
 * and Remove for a stored connection. A switched off tool that always has a
 * row is switched back on from here.
 */
function fillMore(tool, panel) {
  if (tool.code !== "MANUAL") {
    panel.append(moreLine(text("q-morelabel", say("showTool")),
      homeSelectionControl(tool.code, () => {}, document, setProviderEnabled, tool.name)));
  }
  if (tool.code === "CLAUDE") {
    const label = document.createElement("label");
    label.className = "q-morelabel";
    label.htmlFor = "claude-poll";
    label.textContent = say("showClaudeFable");
    const input = document.createElement("input");
    input.id = "claude-poll";
    input.type = "checkbox";
    input.role = "switch";
    input.setAttribute("aria-describedby", "claude-poll-note");
    input.checked = claudePoll === true;
    input.disabled = claudePoll === null;
    input.addEventListener("change", async () => {
      input.disabled = true;
      const result = await setClaudePollEnabled(input.checked);
      if (result.ok) claudePoll = input.checked;
      else input.checked = claudePoll === true;
      input.disabled = claudePoll === null;
      drawnTools = "";
      void refresh();
    });
    const note = text("q-morelabel", say("showClaudeFableNote"));
    note.id = "claude-poll-note";
    panel.append(moreLine(label, input), moreLine(note));
  }
  for (const flag of tool.extra) {
    const route = ["CODEX", "ANTIGRAVITY", "OPENCODE", "CLAUDE"].includes(flag.provider) && flag.fixKind !== "open_app" ? "connect" : "rescan";
    const words = fixWords(flag, route);
    if (words.action === null) continue;
    const fix = document.createElement("button");
    fix.type = "button";
    fix.className = "q-btn q-btn-ghost";
    fix.textContent = say(words.action);
    fix.setAttribute("title", say(words.detail, { name: tool.name }));
    fix.addEventListener("click", () => void (route === "connect" ? connectTool(tool.code) : checkTool(tool.code)));
    panel.append(moreLine(text("q-morelabel", say(words.issue, { name: tool.name })), fix));
  }
  if (tool.code !== "OPENROUTER") {
    for (const record of recordsFor(tool.code)) {
      panel.append(moreLine(text("q-morelabel", String(record.accountAlias ?? record.maskedLabel ?? tool.name)),
        confirmButton(say("removeTool"), async () => {
          await removeConnection(record.id);
          await refresh();
        })));
    }
  }
}

/* ------------------------------------------------------------ the key rows */

let drawnKeys = "";
const requestKeyRepaint = keyRepaintGate(document, elements.keyRows);

/** Move to a key row's field, for a tool row whose Connect is its key. */
function focusKey(provider) {
  const field = elements.keyRows.querySelector(`[data-key-row="${provider}"] input`);
  field?.scrollIntoView({ behavior: "smooth", block: "center" });
  field?.focus({ preventScroll: true });
  return say("pasteOpenRouterKey");
}

const keyHandlers = {
  markFor: officialMark,
  /* A refused row replaces only its connection. An empty row adds one. */
  saveOpenrouter: async (secret, recordId, credentialKind) => {
    return saveOpenrouterConnection(secret, recordId, credentialKind, {
      replace: replaceOpenrouterKey,
      save: saveOpenrouterKey,
    });
  },
  /* A saved source reads once right away, so the row goes from Checking key
     to its amount without waiting for the next native poll. */
  save: async (input) => {
    const known = new Set((spendStatus?.sources ?? []).map((source) => source.id));
    const result = await apiSpendSaveSource(input);
    if (result.ok) {
      const saved = input.sourceId ?? result.value?.sources?.find((source) => !known.has(source.id))?.id;
      if (saved) await apiSpendRefresh(saved, false);
    }
    return result;
  },
  saved: async () => {
    drawnKeys = "";
    await refresh();
  },
  refresh: async (row) => {
    const result = row.kind === "quota" ? await refreshConnection(row.recordId) : await apiSpendRefresh(row.sourceId, true);
    await refresh();
    return result;
  },
  remove: async (row) => {
    const result = row.kind === "quota" ? await removeConnection(row.recordId) : await apiSpendRemoveSource(row.sourceId, false);
    await refresh();
    return result;
  },
};

/** Draw every current key row once no key field owns focus. */
function paintKeys(now) {
  requestKeyRepaint(() => {
    const records = inventory.connections.filter((entry) => providerCode(entry.provider) === "OPENROUTER");
    /* Every account's readings: keyRows binds each row to its own connection's. */
    const readings = heldSnapshots.filter((row) => row.provider === "OPENROUTER" && Number.isFinite(row.limitAmount));
    const rows = keyRows({ status: spendStatus, openrouter: { records, readings } }, now);
    const key = JSON.stringify(rows);
    if (key === drawnKeys) return;
    renderKeys(document, elements.keyRows, rows, keyHandlers);
    const spendRows = rows.filter((row) => row.state === "reading" && (row.amount || row.cny));
    elements.spendSection.hidden = spendRows.length === 0;
    renderKeys(document, elements.spendRows, spendRows, keyHandlers, { readOnly: true });
    drawnKeys = key;
  });
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
 * write the new choice down, under the key the site's own toggle uses.
 */
function toggleTheme() {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  const next = light ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  const theme = document.getElementById("theme");
  theme?.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
  if (theme) theme.textContent = themeLabel(next);
  try {
    window.localStorage.setItem(THEME_KEY, next);
  } catch {
    /* Storage refused. The choice still applies to this window. */
  }
}
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("#theme")) toggleTheme();
});

/* The tools' steps: Claude Code's setup, the pasted keys, Codex's import. */
initConnections({
  onMetersChanged: () => {
    void refresh();
  },
  hasFreshLocalClaude: () => freshLocalClaude,
});

/* The agents section exists only while a session does. */
const disposeAgents = mountAgents(elements.agentsMount, {
  markFor: officialMark,
  onCount: (count) => { elements.agentsSection.hidden = count === 0; },
});
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
  copyText: async (value) => {
    try {
      await navigator.clipboard.writeText(String(value));
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
  onAccountState: async (status) => {
    applyAccountState(status);
    await readPlan();
    await renderSettings(elements.settingsMount);
    if (status.syncEnabled !== false) {
      void accountSyncConfiguredSnapshot(readConfiguredProviders());
    }
  },
  onContinue: () => {
    void refresh();
  },
  /* An install row's tool gets its own step on the one screen. */
  onInstall: (provider) => {
    document.getElementById("tab-tools")?.click();
    const code = providerCode(provider);
    void (ALWAYS_LISTED.includes(code) || code === "CODEX" ? toolHandlers.connect(code) : checkTool(code));
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
