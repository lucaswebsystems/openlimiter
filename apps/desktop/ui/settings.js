/**
 * The settings half of the menu: short labels, switches, no paragraphs.
 *
 * Alerts on or off with their 60, 80 and 90 thresholds and the reset notice,
 * quiet hours, snooze, the theme preset, the edge tab, the Claude direct poll
 * and the provider switches. Everything the Settings tab did stays reachable
 * here; what it said in sentences is gone (Lucas, 2026-10-01). The one
 * sentence kept is the Claude direct poll's, because that switch reads a
 * local sign in.
 *
 * Quiet hours keep contract 5.2's shape (start inclusive, end exclusive, a
 * range may cross midnight, start equal to end is off), so the switch turns
 * them off by writing equal times and on by writing a real range: the trap of
 * two equal times meaning "off" can no longer be set by accident.
 *
 * The theme presets are gated on the `theme_preset` entitlement and downgrade
 * gracefully: losing Pro returns the window to the default theme and leaves
 * the chosen preset remembered rather than deleting it.
 */
import {
  BACKEND_ABSENT,
  accountStatus,
  notificationSettings,
  proStatus,
  proService,
  setClaudePollEnabled,
  setNotificationSettings,
  setTerminalCaptions,
  terminalCaptions,
} from "./backend.js";
import { activityClient } from "./agents.js";
import { say } from "./names.js";
import { LOCK } from "./pro.js";

// English catalog for the menu's settings. L7 owns translations.
export const ALERTS_EN = Object.freeze({
  title: "Alerts",
  signInLead: "Every bar and every desktop alert is free with no account, and signing in brings sync to your phone, with Pro adding phone push, email and more than one account per provider.",
  reset: "Reset",
  quiet: "Quiet hours",
  zone: "Time zone",
  device: "This device",
  snooze: "Snooze",
  snoozeOff: "Off",
  snoozeUntil: "Until {time}",
  unavailable: "Alerts unavailable in this build",
});

/* The one sentence the menu keeps (plan 2.0.3, Step 2). */
export const CLAUDE_POLL_EN = Object.freeze({
  label: say("showClaudeFable"),
  note: say("showClaudeFableNote"),
});

export const MENU_EN = Object.freeze({ tools: "Tools", preset: "Theme preset", agentAlerts: "Agent alerts" });
export const CAPTIONS_EN = Object.freeze({
  title: say("terminalCaptions"),
  short: say("terminalCaptionsShort"),
  tagged: say("terminalCaptionsTagged"),
  note: say("terminalCaptionsNote"),
});

// English catalog for the trial control. L7 owns translations.
export const TRIAL_EN = Object.freeze({
  start: "Start your free 30 day Pro trial",
  free: "No card needed",
  working: "Starting",
  done: "Pro was turned on",
  dayLeft: "Pro trial, 1 day left",
  daysLeft: "Pro trial, {count} days left",
  unavailable: "That did not go through. Try again in a moment.",
  alreadyUsed: "This account has already had its trial.",
});

export const TRIAL_URL = "https://openlimiter.com/app?trial=1";

/** Open the fixed web trial flow with the desktop's existing safe link shape. */
export function openTrialInBrowser(url = TRIAL_URL) {
  return window.open(url, "_blank", "noopener,noreferrer");
}

/** Bring the plan card into view: open the menu when it is closed, then scroll. */
export function showPlan(doc = document) {
  doc.getElementById("tab-settings")?.click();
  doc.getElementById("pro-plan")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
}

/**
 * The trial control, from the account's plan read (`account_status`).
 *
 * A null entitlement is an account that has never had a trial or a plan, the
 * same rule the web hub offers its trial on. Any entitlement row means the
 * trial was used or a plan exists, so only a trial still running shows.
 */
export function desktopTrialState(account, result, now = Date.now()) {
  if (account?.signedIn !== true || !result?.ok) return { kind: "hidden" };
  const value = result.value;
  if (!value || typeof value !== "object" || !("entitlement" in value)) return { kind: "hidden" };
  const row = value.entitlement;
  if (row === null) return { kind: "offer" };
  if (typeof row !== "object") return { kind: "hidden" };
  const end = Date.parse(row.trial_ends_at ?? "");
  if (row.plan_state === "trialing" && Number.isFinite(end) && end > now) {
    return { kind: "running", days: Math.ceil((end - now) / 86_400_000) };
  }
  return { kind: "hidden" };
}

export function desktopTrialMarkup(state, { busy = false, complete = false, error = null } = {}) {
  let markup = "";
  if (state.kind === "offer" && !complete) {
    markup = '<button type="button" class="trial-start" data-trial-start' +
      (busy ? ' disabled aria-busy="true"' : "") + '>' +
      (busy ? TRIAL_EN.working : TRIAL_EN.start) +
      '</button><p class="trial-note">' + TRIAL_EN.free + '</p>';
  } else if (state.kind === "running") {
    markup = '<a class="trial-chip" data-trial-billing href="#pro-plan">' +
      (state.days === 1 ? TRIAL_EN.dayLeft : TRIAL_EN.daysLeft.replace("{count}", String(state.days))) + '</a>';
  }
  if (complete && state.kind !== "hidden") markup += '<p class="trial-note" role="status">' + TRIAL_EN.done + '</p>';
  if (error) markup += '<p class="trial-note" role="alert">' + escapeText(error) + '</p>';
  return markup;
}

/** Every mount shares one flight, so a second press cannot send another start. */
export function createDesktopTrial(
  api = { accountStatus, proService },
  changed = () => {},
  openBrowser = openTrialInBrowser,
) {
  let account = null;
  let result = null;
  let busy = false;
  let complete = false;
  let error = null;
  let revision = 0;
  const snapshot = () => ({
    state: complete && account?.signedIn === true && (!result?.ok || !result.value)
      ? { kind: "started" } : desktopTrialState(account, result),
    busy, complete, error,
  });
  async function refresh(afterStart = false) {
    if (busy && !afterStart) return;
    const request = ++revision;
    const next = await api.accountStatus();
    const hosted = next.ok && next.value?.signedIn === true
      ? await api.proService("account_status") : null;
    if (request !== revision) return;
    const nextAccount = next.ok ? next.value : null;
    if (account?.email !== nextAccount?.email) { complete = false; error = null; }
    account = nextAccount;
    result = hosted;
    if (account?.signedIn !== true) { complete = false; error = null; }
    changed(snapshot());
  }
  async function start() {
    if (busy || complete || snapshot().state.kind !== "offer") return;
    busy = true;
    error = null;
    changed(snapshot());
    try {
      if (openBrowser(TRIAL_URL) === null) error = TRIAL_EN.unavailable;
    } catch {
      error = TRIAL_EN.unavailable;
    } finally {
      busy = false;
      changed(snapshot());
    }
  }
  return { refresh, start, snapshot };
}

function paintDesktopTrial() {
  const { state: trial, ...notice } = desktopTrial.snapshot();
  for (const mount of document.querySelectorAll("[data-desktop-trial]")) {
    const markup = desktopTrialMarkup(trial, notice);
    if (mount.innerHTML === markup) continue;
    mount.innerHTML = markup;
    mount.hidden = mount.innerHTML === "";
    mount.querySelector("[data-trial-start]")?.addEventListener("click", () => void desktopTrial.start());
    mount.querySelector("[data-trial-billing]")?.addEventListener("click", (event) => {
      event.preventDefault();
      showPlan();
    });
  }
}

const desktopTrial = createDesktopTrial(undefined, paintDesktopTrial);
export async function refreshDesktopTrial() {
  await desktopTrial.refresh();
}

export function tickDesktopTrial() { paintDesktopTrial(); }

const THRESHOLDS = [
  { key: "threshold60", label: "60%" },
  { key: "threshold80", label: "80%" },
  { key: "threshold90", label: "90%" },
];

/*
 * A short list, offered as a starting point rather than as the whole world.
 * Following this device is the default, so the list never has to be complete
 * to be correct.
 */
const ZONES = [
  "America/Sao_Paulo",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

const SNOOZE_WINDOWS = [
  { label: "30 minutes", minutes: 30 },
  { label: "2 hours", minutes: 120 },
  { label: "12 hours", minutes: 60 * 12 },
];

/* The tools the menu can switch, in the order the directory lists them. */
const TOOL_SWITCHES = ["CLAUDE", "CODEX", "ANTIGRAVITY", "GEMINI_CLI", "GROK", "KIMI", "OPENCODE", "OPENROUTER", "CURSOR"];

const PRESETS = [
  { id: "default", name: "Product", swatches: ["var(--ol-canvas)", "var(--ol-surface)", "var(--ol-accent)"] },
  { id: "graphite", name: "Graphite", swatches: ["var(--ol-code)", "var(--ol-elevated)", "var(--ol-soft)"] },
  { id: "meadow", name: "Meadow", swatches: ["var(--ol-canvas)", "var(--ol-raised)", "var(--ol-band-green-fill)"] },
  { id: "ember", name: "Ember", swatches: ["var(--ol-canvas)", "var(--ol-raised)", "var(--ol-band-orange-fill)"] },
];

const PRESET_KEY = "openlimiter-theme-preset";

export function themeLabel(theme) {
  return say(theme === "light" ? "themeLight" : "themeDark");
}

/* The quiet range a switched on quiet hours starts from. */
const QUIET_DEFAULT = { quietStart: "22:00", quietEnd: "07:00" };

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/* The one switch the menu uses everywhere, the same as the tool switches. */
function switchMarkup(id, checked, disabled = false) {
  return (
    '<span class="provider-switch"><input type="checkbox" role="switch" id="' + id + '"' +
    (checked ? " checked" : "") +
    (disabled ? " disabled" : "") +
    ' /><span class="provider-switch-track" aria-hidden="true"></span></span>'
  );
}

function systemZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch (error) {
    return "UTC";
  }
}

/** Contract 5.2: start equal to end, or either missing, is no quiet period. */
export function quietOn(settings) {
  const start = settings.quietStart ?? "";
  const end = settings.quietEnd ?? "";
  return start !== "" && end !== "" && start !== end;
}

/** UTC, with the Z the contract requires, from a number of minutes ahead. */
export function snoozeUntil(minutes, now = Date.now()) {
  return new Date(now + minutes * 60_000).toISOString().replace(/\.\d+Z$/u, ".000Z");
}

const state = { settings: null, mount: null, agentAlerts: null };

export const RAIL_SETTINGS_COPY = {
  show: "Show the edge tab",
  detail: "A small tab on the left edge of your screen. Hover it to see usage and agents.",
  unavailable: "Edge tab settings are unavailable.",
  saveFailed: "Could not save the edge tab setting. Try again.",
};

/* The edge tab's switch; its one line of detail rides in the title. */
function railSettingsMarkup() {
  return '<div class="menu-line" title="' + escapeText(RAIL_SETTINGS_COPY.detail) + '">' +
    '<label for="rail-visible">' + RAIL_SETTINGS_COPY.show + '</label>' +
    switchMarkup("rail-visible", false, true) + '</div>' +
    '<p id="rail-visibility-status" class="menu-note" role="status"></p>';
}

export async function wireRailVisibility(control, status, invoke = globalThis.window?.__TAURI__?.core?.invoke) {
  let persisted;
  control.disabled = true;
  const read = async () => {
    const snapshot = await invoke("plugin:rail|rail_snapshot", {});
    if (typeof snapshot?.window?.visible !== "boolean") throw new Error("Invalid Rail state");
    persisted = snapshot.window.visible;
    control.checked = persisted;
  };
  try {
    await read();
    control.disabled = false;
  } catch {
    status.textContent = RAIL_SETTINGS_COPY.unavailable;
    return;
  }
  control.addEventListener("change", async () => {
    if (control.disabled) return;
    const visible = control.checked;
    control.disabled = true;
    status.textContent = "";
    try {
      await invoke("plugin:rail|rail_set_visible", { visible });
      persisted = visible;
      await read();
    } catch {
      control.checked = persisted;
      status.textContent = RAIL_SETTINGS_COPY.saveFailed;
    } finally {
      control.disabled = false;
    }
  });
}

function wireRailSettings(mount) {
  return wireRailVisibility(mount.querySelector("#rail-visible"), mount.querySelector("#rail-visibility-status"));
}

export function presetMarkup(entitled, chosen) {
  return PRESETS.map(
    (preset) => {
      const locked = !entitled && preset.id !== "default";
      return '<button type="button" class="preset" data-preset="' + preset.id + '" aria-pressed="' + String(preset.id === chosen) + '"' +
        (locked ? " disabled" : "") +
        '><span class="preset-swatches" aria-hidden="true">' +
        preset.swatches.map((swatch) => '<span class="preset-swatch" style="background:' + swatch + '"></span>').join("") +
        '</span>' + (locked ? '<span class="menu-lock" aria-hidden="true">' + LOCK + "</span>" : "") +
        '<span class="preset-name">' + escapeText(preset.name) + "</span></button>";
    }
  ).join("");
}

function snoozeMarkup(settings) {
  const until = Date.parse(settings.snoozedUntil ?? "");
  const snoozed = Number.isFinite(until) && until > Date.now();
  const time = snoozed ? new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return '<select class="menu-select" id="snooze" aria-label="' + ALERTS_EN.snooze + '">' +
    (snoozed ? '<option value="keep" selected>' + escapeText(ALERTS_EN.snoozeUntil.replace("{time}", time)) + "</option>" : "") +
    '<option value="0"' + (snoozed ? "" : " selected") + ">" + ALERTS_EN.snoozeOff + "</option>" +
    SNOOZE_WINDOWS.map((window) => '<option value="' + String(window.minutes) + '">' + escapeText(window.label) + "</option>").join("") +
    "</select>";
}

function alertsMarkup(settings) {
  const enabled = settings.enabled !== false;
  const quiet = quietOn(settings);
  const follow = settings.followSystemTimeZone !== false;
  return (
    '<div class="menu-line"><label for="alerts-enabled"><strong>' + ALERTS_EN.title + "</strong></label>" +
    switchMarkup("alerts-enabled", enabled) + "</div>" +
    '<div class="menu-checks" role="group" aria-label="' + ALERTS_EN.title + '">' +
    THRESHOLDS.map((threshold) =>
      '<label class="menu-check"><input type="checkbox" id="alerts-' + threshold.key + '"' +
      (settings[threshold.key] !== false ? " checked" : "") + (enabled ? "" : " disabled") + " />" +
      threshold.label + "</label>").join("") +
    '<label class="menu-check"><input type="checkbox" id="alerts-reset"' +
    (settings.reset !== false ? " checked" : "") + (enabled ? "" : " disabled") + " />" + ALERTS_EN.reset + "</label>" +
    "</div>" +
    '<div class="menu-line"><label for="quiet-on">' + ALERTS_EN.quiet + "</label>" + switchMarkup("quiet-on", quiet) + "</div>" +
    (quiet
      ? '<div class="menu-line menu-times">' +
        '<input type="time" id="quiet-start" value="' + escapeText(settings.quietStart) + '" aria-label="Quiet hours start" />' +
        '<span aria-hidden="true">to</span>' +
        '<input type="time" id="quiet-end" value="' + escapeText(settings.quietEnd) + '" aria-label="Quiet hours end" />' +
        "</div>" +
        '<div class="menu-line"><label for="quiet-zone">' + ALERTS_EN.zone + "</label>" +
        '<select class="menu-select" id="quiet-zone"><option value=""' + (follow ? " selected" : "") + ">" + ALERTS_EN.device + "</option>" +
        ZONES.map((zone) => '<option value="' + escapeText(zone) + '"' + (!follow && zone === settings.timeZone ? " selected" : "") + ">" + escapeText(zone) + "</option>").join("") +
        "</select></div>"
      : "") +
    '<div class="menu-line"><label for="snooze">' + ALERTS_EN.snooze + "</label>" + snoozeMarkup(settings) + "</div>"
  );
}

function themeMarkup() {
  const current = globalThis.document?.documentElement?.getAttribute("data-theme") === "light" ? "light" : "dark";
  return '<div class="menu-line"><span>' + say("theme") + '</span><button type="button" id="theme" class="icon" aria-label="' + say("themeToggle") + '" title="' + say("themeToggle") + '">' + themeLabel(current) + '</button></div>';
}

export function captionsMarkup(captions, entitled) {
  return '<div class="menu-presets terminal-captions"><span>' + CAPTIONS_EN.title + '</span><span class="preset-grid">' +
    '<button type="button" class="preset" data-caption="short" aria-pressed="' + String(captions === "short") + '">' + CAPTIONS_EN.short + '</button>' +
    '<button type="button" class="preset" data-caption="tagged" aria-pressed="' + String(captions === "tagged") + '"' + (entitled ? "" : " disabled") + '>' +
    (entitled ? "" : '<span class="menu-lock" aria-hidden="true">' + LOCK + "</span>") + CAPTIONS_EN.tagged + '</button></span></div>' +
    '<p class="menu-note">' + CAPTIONS_EN.note + '</p>';
}

function appearanceMarkup(chosen, entitled, captions) {
  return themeMarkup() +
    '<div class="menu-presets"><span>' + MENU_EN.preset + '</span><span class="preset-grid">' + presetMarkup(entitled, chosen) + "</span></div>" +
    captionsMarkup(captions, entitled) + railSettingsMarkup();
}

/** Settings are divided into appearance and alerts mounts, while account and Pro stay in the page. */
export async function renderSettings(mount) {
  const ownerDocument = mount?.ownerDocument ?? globalThis.document ?? null;
  const target = mount?.appearance
    ? mount
    : { appearance: mount, alerts: ownerDocument?.getElementById("settings-alerts") ?? mount };
  if (!target.alerts) target.alerts = target.appearance;
  state.mount = target.appearance;
  if (target.appearance === null) return;

  const agents = activityClient();
  const [settingsResult, proResult, captionsResult, agentResult] = await Promise.all([
    notificationSettings(),
    proStatus(),
    terminalCaptions(),
    agents.preferences().then((value) => ({ ok: true, value }), () => ({ ok: false })),
  ]);

  if (!settingsResult.ok && settingsResult.reason === BACKEND_ABSENT) {
    target.appearance.innerHTML = appearanceMarkup("default", false, "short");
    const unavailable = '<p class="menu-note">' + ALERTS_EN.unavailable + "</p>";
    if (target.alerts === target.appearance) target.appearance.innerHTML += unavailable;
    else target.alerts.innerHTML = unavailable;
    await wireRailSettings(target.appearance);
    return;
  }

  const settings = settingsResult.ok ? settingsResult.value : {};
  state.settings = settings;
  const pro = proResult.ok ? proResult.value : null;
  const entitled = pro?.theme_preset === true;
  const captions = captionsResult.ok && captionsResult.value?.captions === "tagged" ? "tagged" : "short";
  let chosen = "default";
  try {
    chosen = globalThis.localStorage.getItem(PRESET_KEY) ?? "default";
  } catch (error) {
    /* Storage refused. The product preset is already the default. */
  }
  /* Graceful downgrade: the preset stays chosen, the window simply stops
     applying it until the entitlement returns. */
  ownerDocument?.documentElement?.setAttribute("data-preset", entitled ? chosen : "default");

  state.agentAlerts = agentResult.ok ? agentResult.value : null;
  target.appearance.innerHTML = appearanceMarkup(chosen, entitled, captions);
  target.alerts.innerHTML =
    alertsMarkup(settings) +
    '<div class="menu-line"><label for="agent-alerts">' + MENU_EN.agentAlerts + "</label>" +
    switchMarkup("agent-alerts", state.agentAlerts?.local?.enabled === true, state.agentAlerts === null) + "</div>";

  wire(agents);
  await wireRailSettings(target.appearance);
}

async function save(patch) {
  const next = { ...state.settings, ...patch };
  state.settings = next;
  const result = await setNotificationSettings(next);
  if (result.ok && result.value !== null && typeof result.value === "object") {
    state.settings = { ...next, ...result.value };
  }
}

function wire(agents) {
  const byId = (id) => document.getElementById(id);
  /* Agent toasts keep their own preferences in the activity engine; the
     menu offers their one switch. */
  byId("agent-alerts")?.addEventListener("change", async (event) => {
    const saved = state.agentAlerts;
    const next = { ...saved, local: { ...saved.local, enabled: event.target.checked } };
    try {
      await agents.savePreferences(next);
      state.agentAlerts = next;
    } catch {
      event.target.checked = !event.target.checked;
    }
  });
  byId("alerts-enabled")?.addEventListener("change", async (event) => {
    await save({ enabled: event.target.checked });
    await renderSettings(state.mount);
  });
  for (const key of [...THRESHOLDS.map((threshold) => threshold.key), "reset"]) {
    const node = byId("alerts-" + key);
    node?.addEventListener("change", () => void save({ [key]: node.checked }));
  }
  byId("quiet-on")?.addEventListener("change", async (event) => {
    await save(event.target.checked ? QUIET_DEFAULT : { quietStart: "00:00", quietEnd: "00:00" });
    await renderSettings(state.mount);
  });
  for (const id of ["quiet-start", "quiet-end"]) {
    byId(id)?.addEventListener("change", () => void save({
      quietStart: byId("quiet-start")?.value ?? "",
      quietEnd: byId("quiet-end")?.value ?? "",
    }));
  }
  byId("quiet-zone")?.addEventListener("change", (event) => {
    const zone = event.target.value;
    void save({ followSystemTimeZone: zone === "", timeZone: zone === "" ? systemZone() : zone });
  });
  byId("snooze")?.addEventListener("change", (event) => {
    const value = event.target.value;
    if (value === "keep") return;
    const minutes = Number(value);
    void save({ snoozedUntil: minutes === 0 ? null : snoozeUntil(minutes) });
  });
  byId("claude-poll")?.addEventListener("change", async (event) => {
    const requested = event.target.checked;
    event.target.disabled = true;
    const result = await setClaudePollEnabled(requested);
    event.target.checked = result.ok ? requested : !requested;
    event.target.disabled = false;
  });
  for (const control of document.querySelectorAll("[data-preset]")) {
    control.addEventListener("click", async () => {
      if (control.disabled) return;
      try {
        globalThis.localStorage.setItem(PRESET_KEY, control.getAttribute("data-preset"));
      } catch (error) {
        /* Storage refused. The choice lasts for this window only. */
      }
      await renderSettings(state.mount);
    });
  }
  for (const control of document.querySelectorAll("[data-caption]")) {
    control.addEventListener("click", async () => {
      if (control.disabled) return;
      const result = await setTerminalCaptions(control.getAttribute("data-caption"));
      if (result.ok) await renderSettings(state.mount);
    });
  }
}
