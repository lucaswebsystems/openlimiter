/**
 * Notifications and settings.
 *
 * Contract 5.2 is the shape of the quiet hours block, and it is stricter than
 * it looks. Start is inclusive and end is exclusive, a range may cross
 * midnight, and start equal to end means there is no quiet period at all. That
 * last one is the trap: a person who drags both ends together has just turned
 * quiet hours off, so the screen says so in words rather than leaving them to
 * discover it at two in the morning.
 *
 * The same section says an event created during quiet hours or before the
 * snooze ends is terminally suppressed for push. It is never released as a
 * burst afterwards. That is a promise worth printing on the screen, because
 * the alternative a person reasonably fears is nine hours of alerts arriving
 * at breakfast, and nothing else on this surface would tell them otherwise.
 *
 * Every preference change bumps the channel epoch, which invalidates work a
 * worker may already have claimed. The epoch is shown, in the same monospace
 * every other machine value uses, because a person who changes a setting and
 * still receives one more alert deserves to see the number that explains it.
 *
 * The theme presets are gated on the `theme_preset` entitlement and downgrade
 * gracefully: losing Pro returns the window to the default theme and leaves
 * the chosen preset visible and reselectable rather than deleting it. Nothing
 * local ever stops working because a subscription lapsed, and a preset is the
 * one cosmetic thing Pro is allowed to hold.
 */
import {
  BACKEND_ABSENT,
  accountEmail,
  accountLogout,
  accountOauth,
  accountStatus,
  notificationEvents,
  notificationSettings,
  proStatus,
  proService,
  setNotificationSettings,
} from "./backend.js";

// English catalog for desktop quota alerts. L7 owns translations.
export const ALERTS_EN = Object.freeze({
  title: "Desktop alerts",
  localFreeTitle: "Desktop alerts stay free",
  localFree: "Desktop alerts stay free, with or without an account. Phone push and email are Pro.",
  signInLead: "Every bar and every desktop alert is free with no account, and signing in brings sync to your phone, with Pro adding phone push, email and more than one account per provider.",
  thresholds: "OpenLimiter tells you when a window crosses a threshold, and once more when it resets.",
  quietPrefix: "Desktop alerts are held from ",
  snooze: "Hold desktop alerts for a while. Anything raised during a snooze is dropped rather than stacked up, so it never arrives all at once when the snooze ends.",
  channelOn: "Desktop alerts on",
  channelOff: "Desktop alerts off",
});

// English catalog for the Home and Settings trial control. L7 owns translations.
export const TRIAL_EN = Object.freeze({
  start: "Start your free 30 day Pro trial",
  signIn: "Sign in to start your free 30 day Pro trial",
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

export function desktopTrialState(account, result, now = Date.now()) {
  if (account?.signedIn !== true || !result?.ok) return { kind: "hidden" };
  const row = result.value;
  if (!row || typeof row !== "object") return { kind: "hidden" };
  const plan = row.plan_state ?? row.status;
  const end = Date.parse(row.trial_ends_at ?? "");
  if ((plan === "trial" || plan === "trialing") && Number.isFinite(end) && end > now) {
    return { kind: "running", days: Math.ceil((end - now) / 86_400_000) };
  }
  if ((plan === "none" || plan === "free") && row.trial_ends_at == null &&
      row.trial_started_at == null && row.had_paid_entitlement !== true && row.trial_used !== true) {
    return { kind: "offer" };
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
    markup = '<a class="trial-chip" data-trial-billing href="#pro-mount">' +
      (state.days === 1 ? TRIAL_EN.dayLeft : TRIAL_EN.daysLeft.replace("{count}", String(state.days))) + '</a>';
  }
  if (complete && state.kind !== "hidden") markup += '<p class="trial-note" role="status">' + TRIAL_EN.done + '</p>';
  if (error) markup += '<p class="trial-note" role="alert">' + escapeText(error) + '</p>';
  return markup;
}

/** Both mounts share one flight so switching tabs cannot send another start. */
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
      document.getElementById("tab-settings")?.click();
    });
  }
}

const desktopTrial = createDesktopTrial(undefined, paintDesktopTrial);
export async function refreshDesktopTrial() {
  await desktopTrial.refresh();
}

export function tickDesktopTrial() { paintDesktopTrial(); }

const THRESHOLDS = [
  {
    key: "threshold60",
    label: "60 percent",
    detail: "The watch threshold, where a window starts being worth planning around.",
    tone: "watch",
  },
  {
    key: "threshold80",
    label: "80 percent",
    detail: "High utilisation, where the rest of the window needs rationing.",
    tone: "high",
  },
  {
    key: "threshold90",
    label: "90 percent",
    detail: "Critical, where the next long run is likely to be cut off.",
    tone: "critical",
  },
];

/*
 * A short list, offered as a starting point rather than as the whole world.
 * The system zone is the default and is what the toggle above returns to, so
 * this list never has to be complete to be correct.
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
  { label: "Until tomorrow", minutes: 60 * 12 },
];

const PRESETS = [
  {
    id: "default",
    name: "Product",
    swatches: ["var(--ol-canvas)", "var(--ol-surface)", "var(--ol-accent)"],
  },
  {
    id: "graphite",
    name: "Graphite",
    swatches: ["var(--ol-code)", "var(--ol-elevated)", "var(--ol-soft)"],
  },
  {
    id: "meadow",
    name: "Meadow",
    swatches: [
      "var(--ol-canvas)",
      "var(--ol-raised)",
      "var(--ol-band-green-fill)",
    ],
  },
  {
    id: "ember",
    name: "Ember",
    swatches: [
      "var(--ol-canvas)",
      "var(--ol-raised)",
      "var(--ol-band-orange-fill)",
    ],
  },
];

const PRESET_KEY = "openlimiter-theme-preset";

const KIND_LABELS = {
  threshold_60: "60%",
  threshold_80: "80%",
  threshold_90: "90%",
  reset: "reset",
};

const STATUS_SENTENCES = {
  complete: "Delivered",
  queued: "Waiting to send",
  coalesced: "Folded into an earlier alert",
  suppressed: "Held by quiet hours or snooze",
};

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function switchMarkup(id, checked, disabled = false) {
  return (
    '<span class="switch"><input type="checkbox" id="' +
    id +
    '"' +
    (checked ? " checked" : "") +
    (disabled ? " disabled" : "") +
    ' /><span class="switch-thumb" aria-hidden="true"></span></span>'
  );
}

function systemZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  } catch (error) {
    return "UTC";
  }
}

/**
 * Quiet hours, in one sentence, including the case a control cannot show.
 *
 * The equal case is the one that matters. Start equal to end disables the
 * period entirely, which is the opposite of what two identical times look
 * like they mean, so it is stated rather than implied.
 */
export function quietSentence(settings) {
  const start = settings.quietStart ?? "";
  const end = settings.quietEnd ?? "";
  if (start === "" || end === "") return "Quiet hours are off.";
  if (start === end) {
    return "Start and end are the same time, which turns quiet hours off. Nothing is held.";
  }
  const crosses = start > end;
  return (
    ALERTS_EN.quietPrefix +
    start +
    " until " +
    end +
    (crosses ? " the next morning" : "") +
    ", in " +
    (settings.timeZone ?? systemZone()) +
    ". An alert raised inside that window is never delivered late as a burst afterwards."
  );
}

export function snoozeSentence(settings) {
  const until = settings.snoozedUntil;
  if (typeof until !== "string" || until === "") return "Not snoozed.";
  const at = Date.parse(until);
  if (!Number.isFinite(at)) return "Not snoozed.";
  if (at <= Date.now()) return "The snooze has ended.";
  return "Snoozed until " + new Date(at).toLocaleString() + ".";
}

/** UTC, with the Z the contract requires, from a number of minutes ahead. */
export function snoozeUntil(minutes, now = Date.now()) {
  return new Date(now + minutes * 60_000).toISOString().replace(/\.\d+Z$/u, ".000Z");
}

const state = { settings: null, pro: null, mount: null };

export const RAIL_SETTINGS_COPY = {
  show: "Show the edge tab",
  detail: "A small tab on the left edge of your screen. Hover it to see usage and agents.",
  unavailable: "Edge tab settings are unavailable.",
  saveFailed: "Could not save the edge tab setting. Try again.",
};

function railSettingsMarkup() {
  return '<section class="surface block"><div class="line">' +
    '<label class="line-label" for="rail-visible"><strong>' + RAIL_SETTINGS_COPY.show +
    '</strong><span>' + RAIL_SETTINGS_COPY.detail + '</span></label>' +
    switchMarkup("rail-visible", false, true) + '</div>' +
    '<p id="rail-visibility-status" class="note" role="status"></p></section>';
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

function eventsMarkup(events) {
  if (events.length === 0) {
    return '<p class="note">No alert has been raised yet.</p>';
  }
  return events
    .slice(0, 6)
    .map(
      (event) =>
        '<div class="event-row"><span class="event-kind mono">' +
        escapeText(KIND_LABELS[event.kind] ?? event.kind) +
        '</span><span class="event-body"><strong>' +
        escapeText(
          (event.provider ?? "") +
            (event.accountId ? " " + event.accountId : "") +
            ", " +
            (event.windowName ?? "")
        ) +
        "</strong><span>" +
        escapeText(
          (STATUS_SENTENCES[event.status] ?? event.status) +
            " on " +
            (event.channel ?? "push")
        ) +
        '</span></span><span class="badge"' +
        (event.status === "suppressed" ? ' data-tone="watch"' : "") +
        ">" +
        escapeText(event.status ?? "")
        + "</span></div>"
    )
    .join("");
}

function presetMarkup(entitled, chosen) {
  return PRESETS.map(
    (preset) =>
      '<button type="button" class="preset" data-preset="' +
      preset.id +
      '" aria-pressed="' +
      String(preset.id === chosen) +
      '"' +
      (entitled || preset.id === "default" ? "" : " disabled") +
      '><span class="preset-swatches" aria-hidden="true">' +
      preset.swatches
        .map(
          (swatch) =>
            '<span class="preset-swatch" style="background:' + swatch + '"></span>'
        )
        .join("") +
      '</span><span class="preset-name">' +
      escapeText(preset.name) +
      "</span></button>"
  ).join("");
}

function accountMarkup(account) {
  if (account === null || account.signedIn !== true) {
    return (
      '<div class="stack">' +
      '<p class="note tight">Sign in to carry your settings between devices. Everything local keeps working signed out, and nothing on this machine is paywalled.</p>' +
      '<div class="trial-offer"><strong>' + TRIAL_EN.signIn + '</strong><p>No credit card needed</p></div>' +
      '<div class="button-row">' +
      '<button type="button" id="settings-github">Continue with GitHub</button>' +
      '<button type="button" id="settings-google">Continue with Google</button>' +
      "</div>" +
      '<label class="field-label" for="settings-email">Or use a sign in link by email</label>' +
      '<div class="field-inline">' +
      '<input id="settings-email" class="field" type="email" autocomplete="email" placeholder="you@example.com" />' +
      '<button type="button" id="settings-magic">Send the link</button>' +
      "</div>" +
      '<p class="note" id="settings-account-status" role="status"></p>' +
      "</div>"
    );
  }
  return (
    '<div class="line"><span class="line-label"><strong>' +
    escapeText(account.email ?? "Signed in") +
    "</strong><span>Signed in on this device</span></span>" +
    '<button type="button" id="settings-logout">Log out</button></div>'
  );
}

export async function renderSettings(mount) {
  state.mount = mount;
  if (mount === null) return;

  const [settingsResult, proResult, accountResult, eventsResult] = await Promise.all([
    notificationSettings(),
    proStatus(),
    accountStatus(),
    notificationEvents(),
  ]);

  if (!settingsResult.ok && settingsResult.reason === BACKEND_ABSENT) {
    mount.innerHTML =
      railSettingsMarkup() +
      '<section class="surface block"><h2>Notifications</h2>' +
      '<p class="note">This build has no notification backend, so there is nothing to configure.</p></section>';
    await wireRailSettings(mount);
    return;
  }

  const settings = settingsResult.ok ? settingsResult.value : {};
  const pro = proResult.ok ? proResult.value : null;
  const account = accountResult.ok ? accountResult.value : null;
  const events = eventsResult.ok && Array.isArray(eventsResult.value) ? eventsResult.value : [];
  state.settings = settings;
  state.pro = pro;

  const entitled = pro?.theme_preset === true;
  let chosen = "default";
  try {
    chosen = globalThis.localStorage.getItem(PRESET_KEY) ?? "default";
  } catch (error) {
    /* Storage refused. The product preset is already the default. */
  }
  /* Graceful downgrade: the preset stays chosen and stays visible, the window
     simply stops applying it until the entitlement returns. */
  const applied = entitled ? chosen : "default";
  document.documentElement.setAttribute("data-preset", applied);

  const enabled = settings.enabled !== false;

  mount.innerHTML =
    railSettingsMarkup() +
    '<section class="surface block" aria-labelledby="alerts-title">' +
    '<div class="block-head"><h2 id="alerts-title">' + escapeText(ALERTS_EN.title) + '</h2>' +
    switchMarkup("alerts-enabled", enabled) +
    "</div>" +
    /* The switches below say which crossings to choose. The note says only
       what a crossing is. */
    '<p class="note tight">' + escapeText(ALERTS_EN.localFree) + '</p>' +
    '<p class="note tight">' + escapeText(ALERTS_EN.thresholds) + '</p>' +
    '<div class="stack">' +
    THRESHOLDS.map(
      (threshold) =>
        '<div class="line"><span class="line-label"><strong>' +
        '<span class="badge" data-tone="' +
        threshold.tone +
        '">' +
        escapeText(threshold.label) +
        "</span></strong><span>" +
        escapeText(threshold.detail) +
        "</span></span>" +
        switchMarkup(
          "alerts-" + threshold.key,
          settings[threshold.key] !== false,
          !enabled
        ) +
        "</div>"
    ).join("") +
    '<div class="line"><span class="line-label"><strong>Reset notice</strong>' +
    "<span>One message when a window comes back to full, so you know you can start the long job.</span></span>" +
    switchMarkup("alerts-reset", settings.reset !== false, !enabled) +
    "</div></div></section>" +

    '<section class="surface block" aria-labelledby="quiet-title">' +
    '<h2 id="quiet-title">Quiet hours</h2>' +
    '<div class="line"><span class="line-label"><strong>Follow this device</strong>' +
    "<span>Use the time zone the operating system reports.</span></span>" +
    switchMarkup("quiet-follow", settings.followSystemTimeZone !== false) +
    "</div>" +
    '<div class="line"><span class="line-label"><strong>Time zone</strong>' +
    "<span>Quiet hours are read in this zone, across daylight saving changes.</span></span>" +
    '<select class="field" id="quiet-zone"' +
    (settings.followSystemTimeZone !== false ? " disabled" : "") +
    ">" +
    ZONES.map(
      (zone) =>
        '<option value="' +
        escapeText(zone) +
        '"' +
        (zone === (settings.timeZone ?? systemZone()) ? " selected" : "") +
        ">" +
        escapeText(zone) +
        "</option>"
    ).join("") +
    "</select></div>" +
    '<div class="line"><span class="line-label"><strong>Held between</strong>' +
    "<span>The start is included and the end is not. A range may cross midnight.</span></span>" +
    '<span class="field-inline">' +
    '<input type="time" id="quiet-start" value="' +
    escapeText(settings.quietStart ?? "22:00") +
    '" aria-label="Quiet hours start" />' +
    "<span>to</span>" +
    '<input type="time" id="quiet-end" value="' +
    escapeText(settings.quietEnd ?? "07:30") +
    '" aria-label="Quiet hours end" />' +
    "</span></div>" +
    '<p class="note tight" id="quiet-sentence">' +
    escapeText(quietSentence(settings)) +
    "</p></section>" +

    '<section class="surface block" aria-labelledby="snooze-title">' +
    '<h2 id="snooze-title">Snooze</h2>' +
    '<p class="note tight">' + escapeText(ALERTS_EN.snooze) + '</p>' +
    '<div class="button-row">' +
    SNOOZE_WINDOWS.map(
      (window) =>
        '<button type="button" data-snooze="' +
        String(window.minutes) +
        '">' +
        escapeText(window.label) +
        "</button>"
    ).join("") +
    '<button type="button" data-snooze="0">Clear</button>' +
    "</div>" +
    '<p class="note" id="snooze-sentence">' +
    escapeText(snoozeSentence(settings)) +
    "</p></section>" +

    '<section class="surface block" aria-labelledby="channel-title">' +
    '<div class="block-head"><h2 id="channel-title">Channel</h2>' +
    '<span class="badge" data-tone="' +
    (enabled ? "ok" : "") +
    '">' +
    escapeText(enabled ? ALERTS_EN.channelOn : ALERTS_EN.channelOff) +
    "</span></div>" +
    '<div class="line"><span class="line-label"><strong>Channel version</strong>' +
    "<span>Every change to these settings raises this number and cancels work already queued under the old one. A message accepted by the sender a moment earlier can still arrive.</span></span>" +
    '<span class="mono tracked">' +
    escapeText(String(settings.channelEpoch ?? 0)) +
    "</span></div>" +
    '<div class="stack">' +
    eventsMarkup(events) +
    "</div></section>" +

    '<section class="surface block" aria-labelledby="theme-title">' +
    '<div class="block-head"><h2 id="theme-title">Theme preset</h2>' +
    (entitled
      ? '<span class="badge" data-tone="accent">Pro</span>'
      : '<span class="badge">Pro</span>') +
    "</div>" +
    '<p class="note tight">' +
    (entitled
      ? "A preset changes the accent and surface tones. The five band meter colours never change, because they are the reading and not the decoration."
      : "Presets are the one cosmetic thing Pro holds. Nothing local is paywalled: every meter, every alert and every connection works the same on Free.") +
    "</p>" +
    '<div class="desktop-trial" data-desktop-trial hidden></div>' +
    '<div class="preset-grid">' +
    presetMarkup(entitled, chosen) +
    "</div>" +
    (!entitled && chosen !== "default"
      ? '<p class="note">Your ' +
        escapeText(PRESETS.find((preset) => preset.id === chosen)?.name ?? chosen) +
        " preset is remembered and comes back with Pro. The window is using the product theme until then.</p>"
      : "") +
    "</section>" +

    '<section class="surface block" id="settings-account" aria-labelledby="account-title">' +
    '<h2 id="account-title">Account</h2>' +
    accountMarkup(account) +
    "</section>";

  wire();
  await refreshDesktopTrial();
  await wireRailSettings(mount);
}

async function save(patch) {
  const next = { ...state.settings, ...patch };
  state.settings = next;
  const result = await setNotificationSettings(next);
  if (result.ok && result.value !== null && typeof result.value === "object") {
    state.settings = { ...next, ...result.value };
  }
  const quiet = document.getElementById("quiet-sentence");
  if (quiet !== null) quiet.textContent = quietSentence(state.settings);
  const snooze = document.getElementById("snooze-sentence");
  if (snooze !== null) snooze.textContent = snoozeSentence(state.settings);
  const epoch = document.querySelector("#channel-title")?.closest(".block")
    ?.querySelector(".mono.tracked");
  if (epoch !== null && epoch !== undefined) {
    epoch.textContent = String(state.settings.channelEpoch ?? 0);
  }
}

function wire() {
  const enabled = document.getElementById("alerts-enabled");
  enabled?.addEventListener("change", async () => {
    await save({ enabled: enabled.checked });
    await renderSettings(state.mount);
  });

  for (const threshold of THRESHOLDS) {
    const node = document.getElementById("alerts-" + threshold.key);
    node?.addEventListener("change", () => {
      void save({ [threshold.key]: node.checked });
    });
  }

  const reset = document.getElementById("alerts-reset");
  reset?.addEventListener("change", () => {
    void save({ reset: reset.checked });
  });

  const follow = document.getElementById("quiet-follow");
  follow?.addEventListener("change", async () => {
    await save({
      followSystemTimeZone: follow.checked,
      timeZone: follow.checked ? systemZone() : state.settings.timeZone,
    });
    await renderSettings(state.mount);
  });

  const zone = document.getElementById("quiet-zone");
  zone?.addEventListener("change", () => {
    void save({ timeZone: zone.value });
  });

  for (const id of ["quiet-start", "quiet-end"]) {
    const node = document.getElementById(id);
    node?.addEventListener("change", () => {
      void save({
        quietStart: document.getElementById("quiet-start")?.value ?? "",
        quietEnd: document.getElementById("quiet-end")?.value ?? "",
      });
    });
  }

  for (const control of document.querySelectorAll("[data-snooze]")) {
    control.addEventListener("click", () => {
      const minutes = Number(control.getAttribute("data-snooze"));
      void save({ snoozedUntil: minutes === 0 ? null : snoozeUntil(minutes) });
    });
  }

  for (const control of document.querySelectorAll("[data-preset]")) {
    control.addEventListener("click", async () => {
      if (control.disabled) return;
      const id = control.getAttribute("data-preset");
      try {
        globalThis.localStorage.setItem(PRESET_KEY, id);
      } catch (error) {
        /* Storage refused. The choice lasts for this window only. */
      }
      await renderSettings(state.mount);
    });
  }

  document.getElementById("settings-github")?.addEventListener("click", async () => {
    await accountOauth("github");
    await renderSettings(state.mount);
  });
  document.getElementById("settings-google")?.addEventListener("click", async () => {
    await accountOauth("google");
    await renderSettings(state.mount);
  });
  document.getElementById("settings-magic")?.addEventListener("click", async () => {
    const email = document.getElementById("settings-email")?.value ?? "";
    const status = document.getElementById("settings-account-status");
    if (email.trim() === "") {
      if (status !== null) status.textContent = "Enter the email address to send the link to.";
      return;
    }
    const result = await accountEmail({ email, password: "", create: false });
    if (status !== null) {
      status.textContent = result.ok
        ? "Check " + email + " for the sign in link."
        : "That did not work. " + (result.message ?? "");
    }
  });
  document.getElementById("settings-logout")?.addEventListener("click", async () => {
    await accountLogout();
    await renderSettings(state.mount);
  });
}
