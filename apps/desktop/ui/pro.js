/**
 * The Pro surfaces, and API spend.
 *
 * Two screens live here because they are the two places a person meets the
 * paid layer, and both are governed by the same promise: nothing functional
 * and local is behind the plan. The Pro block sells hosted work, multiple
 * accounts and one cosmetic preset. It never sells a meter.
 *
 * API spend is the sharpest case of that promise. Contract 4.4 makes local
 * display Free, and B2a records the same thing on the wire as
 * `localDisplayIsFree`, so the value on screen is not gated and the module
 * does not check an entitlement before drawing one. Pro adds hosted ninety day
 * history, forecast and budget alerts, which are the things a server actually
 * does.
 *
 * The eligibility screen is quoted, not paraphrased. Contract 4.2 says the
 * meaning MUST be displayed before a secret input is enabled, so the input is
 * genuinely disabled until the disclosure has been seen and accepted, and the
 * five provider sentences are the contract's own words. Softening them would
 * be softening what a person is agreeing to.
 *
 * Moonshot is balance, not spend, at every layer. It has no budget bar, no
 * forecast and no monthly conversion, and the row says the word "balance"
 * rather than leaving a dollar sign to imply the other thing.
 *
 * The UI never runs its own poll. Rust owns the cadence, so manual refresh
 * renders a `too_soon` answer as a fact rather than retrying behind it.
 */
import {
  BACKEND_ABSENT,
  apiSpendRefresh,
  apiSpendRemoveSource,
  apiSpendSaveSource,
  apiSpendStatus,
  proService,
  proStatus,
} from "./backend.js";

/* Contract 4.2, verbatim. The one paragraph a person must have in front of
   them before any secret input becomes usable. */
export const ELIGIBILITY_DISCLOSURE =
  "API Spend is a best effort observation from provider billing or balance APIs. " +
  "It may be delayed, incomplete, corrected, or unavailable. OpenLimiter never " +
  "estimates across a missing period. Your provider credential stays in this " +
  "device's operating system keyring and is sent only to the selected provider's " +
  "fixed HTTPS host. It is never sent to OpenLimiter servers. Local current " +
  "display is Free. For spend observations, Pro adds private hosted 90 day " +
  "history, forecast, and budget alerts. Moonshot is shown as `balance, not " +
  "spend`, with no monthly spend conversion, forecast, or budget alerts.";

/* Contract 4.2, the five provider sentences, verbatim. */
export const PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    metric: "spend",
    eligibility:
      "Requires an Organization Admin API key created by an organization owner. A project API key will not work.",
    team: false,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    metric: "spend",
    eligibility:
      "Requires a Claude Platform organization Admin API key. Workspace keys and individual accounts are not eligible.",
    team: false,
  },
  {
    id: "xai",
    name: "xAI",
    metric: "spend",
    eligibility: "Requires a Management key and the exact team identifier.",
    team: true,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    metric: "spend",
    eligibility:
      "Requires a Management key. Monthly spend is derived from lifetime usage observations and can only cover periods observed without a gap.",
    team: false,
  },
  {
    id: "moonshot",
    name: "Moonshot",
    metric: "balance",
    eligibility:
      "Requires a normal Moonshot server API key. This beta shows current available, voucher, and cash balance as balance, not spend. It never converts balance into monthly spend and never creates a forecast or budget alert from it.",
    team: false,
  },
];

const FEATURES = [
  { key: "multi_account", label: "More than one account per provider" },
  { key: "hosted_history", label: "Ninety days of private hosted history" },
  { key: "forecast", label: "Spend forecast from observed periods" },
  { key: "hosted_alerts", label: "Alerts that arrive with the app closed" },
  { key: "snapshot_sync", label: "Usage carried between your devices" },
  { key: "theme_preset", label: "Theme presets" },
];

const PLAN_NAMES = {
  free: "Free",
  active: "Pro",
  trial: "Pro trial",
  past_due: "Pro, payment failed",
  canceled: "Pro, ending",
};

const TICK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.4 8.4 3 3 6.2-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const LOCK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.4" y="7" width="9.2" height="6.6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

const ACCEPTED_KEY = "openlimiter-spend-consent-v1";
const CONSENT_VERSION = 1;

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function accepted() {
  try {
    return globalThis.localStorage.getItem(ACCEPTED_KEY) === String(CONSENT_VERSION);
  } catch (error) {
    return false;
  }
}

function whenText(value) {
  if (typeof value !== "string" || value === "") return "never";
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "never";
  return new Date(at).toLocaleString();
}

function budgetBand(spend, budget) {
  const used = Number(spend);
  const limit = Number(budget);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const percent = (used / limit) * 100;
  if (percent >= 90) return "red";
  if (percent >= 80) return "orange";
  if (percent >= 60) return "yellow";
  return "green";
}

/* ---------------------------------------------------------------- the plan */

function planMarkup(pro) {
  const planState = pro?.plan_state ?? "free";
  const isPro = planState === "active" || planState === "trial";
  const trialDays = pro?.trial_days_remaining;

  const banner =
    planState === "trial"
      ? '<div class="callout"><strong>' +
        (typeof trialDays === "number"
          ? String(trialDays) + " days left in your trial"
          : "Trial running") +
        "</strong><p>Every Pro capability is on. No card was asked for and none is needed until the trial ends. If it ends without one, the window returns to Free and keeps every local reading, every connection and every setting.</p></div>"
      : planState === "past_due"
      ? '<div class="alert"><strong>The last payment did not go through</strong><p>Pro keeps working until ' +
        escapeText(whenText(pro?.grace_until)) +
        ". Updating the card in the billing portal restores it immediately.</p></div>"
      : planState === "canceled"
      ? '<div class="callout"><strong>Pro ends on ' +
        escapeText(whenText(pro?.expires_at)) +
        "</strong><p>Hosted history and alerts stop then. Nothing local changes, and no credential and no local observation is deleted.</p></div>"
      : "";

  return (
    banner +
    '<div class="plan-card" data-state="' +
    escapeText(planState) +
    '" id="pro-plan">' +
    '<div class="plan-headline"><span class="plan-name">' +
    escapeText(PLAN_NAMES[planState] ?? planState) +
    "</span>" +
    (isPro
      ? '<span class="badge" data-tone="accent">Active</span>'
      : '<span class="badge">Local only</span>') +
    "</div>" +
    '<ul class="feature-list">' +
    FEATURES.map((feature) => {
      const on = pro?.[feature.key] === true || (pro?.features ?? []).includes(feature.key);
      return (
        '<li data-on="' +
        String(on) +
        '">' +
        (on ? TICK : LOCK) +
        "<span>" +
        escapeText(feature.label) +
        "</span>" +
        (on ? "" : '<span class="badge">Pro</span>') +
        "</li>"
      );
    }).join("") +
    "</ul>" +
    '<p class="note tight">Every meter, every alert on this machine, every connection and the whole local API spend display are Free and always will be. Pro pays for the work a server does.</p>' +
    '<div class="button-row">' +
    (isPro
      ? '<button type="button" id="pro-portal">Manage billing</button>' +
        '<button type="button" id="pro-refresh-plan">Refresh entitlement</button>'
      : '<button type="button" class="primary" id="pro-start-trial">Start the 30 day trial</button>' +
        '<button type="button" id="pro-compare">What Pro adds</button>') +
    "</div>" +
    (pro?.grace_until
      ? '<p class="note">Local Pro features keep working offline until ' +
        escapeText(whenText(pro.grace_until)) +
        ", on the honour system. That is a promise about this window, not a promise the hosted service will accept an old authorisation.</p>"
      : "") +
    "</div>"
  );
}

function devicesMarkup(devices, cap) {
  if (devices.length === 0) {
    return '<p class="note">No device is registered yet.</p>';
  }
  return (
    '<p class="cap-line"><span>' +
    String(devices.length) +
    " of " +
    String(cap) +
    " devices in use</span>" +
    (devices.length > 1
      ? '<button type="button" class="small danger" id="pro-revoke-others">Sign out every other device</button>'
      : "") +
    "</p>" +
    devices
      .map(
        (device) =>
          '<div class="device-row"><span class="device-body"><strong>' +
          escapeText(device.name ?? device.id) +
          (device.current === true ? " " : "") +
          "</strong><span>" +
          escapeText(
            (device.platform ?? "unknown") +
              ", last seen " +
              (typeof device.last_seen_at === "number"
                ? new Date(device.last_seen_at).toLocaleString()
                : "never")
          ) +
          "</span></span>" +
          (device.current === true
            ? '<span class="badge" data-tone="ok">This device</span>'
            : '<button type="button" class="small danger" data-revoke="' +
              escapeText(device.id) +
              '">Revoke</button>') +
          "</div>"
      )
      .join("")
  );
}

/* --------------------------------------------------------------- API spend */

function sourceMarkup(source, sample) {
  const isBalance = source.metricKind === "balance";
  const value = isBalance ? sample?.balanceUsd : sample?.spendUsd;
  const band = isBalance ? null : budgetBand(value, source.budgetUsd);
  const incomplete = source.status === "incomplete" || sample?.completeness === "incomplete";

  return (
    '<article class="spend-source" data-provider="' +
    escapeText(source.provider) +
    '"><div class="stack">' +
    '<div class="spend-head"><span class="spend-provider">' +
    escapeText(PROVIDERS.find((p) => p.id === source.provider)?.name ?? source.provider) +
    "</span>" +
    '<span class="badge"' +
    (isBalance ? "" : ' data-tone="accent"') +
    ">" +
    (isBalance ? "balance, not spend" : "spend") +
    "</span>" +
    (incomplete ? '<span class="badge" data-tone="watch">Incomplete</span>' : "") +
    "</div>" +
    '<span class="spend-key mono">' +
    escapeText(source.keyLabel ?? "key") +
    (source.lastFour ? " &middot; ends " + escapeText(source.lastFour) : "") +
    "</span>" +
    '<span class="spend-value">' +
    (value === undefined || value === null ? "no reading" : "$" + escapeText(value)) +
    (isBalance || source.budgetUsd === null || source.budgetUsd === undefined
      ? ""
      : ' <span class="spend-key">of $' + escapeText(source.budgetUsd) + "</span>") +
    "</span>" +
    (band === null
      ? ""
      : '<span class="spend-budget"><span class="spend-budget-fill" data-band="' +
        band +
        '" style="width:' +
        String(
          Math.min(100, (Number(value) / Number(source.budgetUsd)) * 100).toFixed(1)
        ) +
        '%"></span></span>') +
    '<span class="account-detail">' +
    escapeText(
      "Observed " +
        whenText(source.lastObservedAt) +
        (isBalance
          ? ". Balance only, so no forecast and no budget alert is derived from it."
          : sample?.forecastDate
          ? ". Forecast to reach the budget on " + sample.forecastDate + "."
          : incomplete
          ? ". The provider returned a partial answer, so this is not a full period."
          : "")
    ) +
    "</span></div>" +
    '<div class="account-actions">' +
    '<button type="button" class="small" data-spend-refresh="' +
    escapeText(source.id) +
    '">Refresh</button>' +
    '<button type="button" class="small danger" data-spend-remove="' +
    escapeText(source.id) +
    '">Revoke</button>' +
    "</div></article>"
  );
}

function eligibilityMarkup() {
  return (
    '<section class="surface block" aria-labelledby="spend-eligibility-title">' +
    '<div class="block-head"><h2 id="spend-eligibility-title">API spend</h2>' +
    '<span class="badge" data-tone="accent">Beta</span></div>' +
    '<p class="disclosure" id="spend-disclosure">' +
    escapeText(ELIGIBILITY_DISCLOSURE) +
    "</p>" +
    '<h3 class="provider-group-head">Who can connect what</h3>' +
    '<ul class="eligibility-list">' +
    PROVIDERS.map(
      (provider) =>
        "<li><strong>" +
        escapeText(provider.name) +
        "</strong><span>" +
        escapeText(provider.eligibility) +
        "</span></li>"
    ).join("") +
    "</ul>" +
    '<div class="button-row">' +
    '<button type="button" class="primary" id="spend-accept">I have read this. Let me add a key</button>' +
    "</div></section>"
  );
}

function keyFormMarkup() {
  return (
    '<section class="surface block" id="spend-form" aria-labelledby="spend-form-title" hidden>' +
    '<h2 id="spend-form-title">Add a key</h2>' +
    '<label class="field-label" for="spend-provider">Provider</label>' +
    '<select class="field" id="spend-provider">' +
    PROVIDERS.map(
      (provider) =>
        '<option value="' +
        provider.id +
        '">' +
        escapeText(provider.name) +
        "</option>"
    ).join("") +
    "</select>" +
    '<p class="note" id="spend-provider-note">' +
    escapeText(PROVIDERS[0].eligibility) +
    "</p>" +
    '<label class="field-label" for="spend-label">A label, so two keys stay apart</label>' +
    '<input class="field" id="spend-label" type="text" autocomplete="off" spellcheck="false" placeholder="Org admin key" />' +
    '<div id="spend-team-field" hidden>' +
    '<label class="field-label" for="spend-team">Team identifier</label>' +
    '<input class="field" id="spend-team" type="text" autocomplete="off" spellcheck="false" placeholder="team_..." />' +
    "</div>" +
    '<label class="field-label" for="spend-secret">The key</label>' +
    '<input class="field" id="spend-secret" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-admin-..." />' +
    '<p class="field-note">The field is cleared the moment you save. The key goes to this device\'s operating system keyring and after that only the label and the last four characters are ever shown. There is no way to read it back, here or anywhere else.</p>' +
    '<label class="field-label" for="spend-budget">Monthly budget, if you want one</label>' +
    '<input class="field" id="spend-budget" type="text" inputmode="decimal" autocomplete="off" placeholder="100.00" />' +
    '<label class="choice"><input type="checkbox" id="spend-confirm" />' +
    '<span class="choice-body"><strong>Save this key to the operating system keyring</strong>' +
    "<span>It is sent only to the provider's own fixed address, and never to OpenLimiter.</span></span></label>" +
    '<div class="button-row">' +
    '<button type="button" class="primary" id="spend-save" disabled>Save the key</button>' +
    '<button type="button" id="spend-cancel">Cancel</button>' +
    "</div>" +
    '<p class="note" id="spend-note" role="status"></p>' +
    "</section>"
  );
}

/* -------------------------------------------------------------- rendering */

const state = { mount: null, spend: null, pro: null };

export async function renderPro(mount) {
  state.mount = mount;
  if (mount === null) return;

  const [proResult, devicesResult] = await Promise.all([
    proStatus(),
    proService("device_status", {}),
  ]);

  if (!proResult.ok && proResult.reason === BACKEND_ABSENT) {
    mount.innerHTML =
      '<section class="surface block"><h2>Plan</h2><p class="note">This build has no account backend, so the plan cannot be read. Everything local keeps working.</p></section>';
    return;
  }

  const pro = proResult.ok ? proResult.value : null;
  state.pro = pro;
  const devices = devicesResult.ok ? (devicesResult.value?.devices ?? []) : [];
  const cap = pro?.device_cap ?? 1;
  const isPro = pro?.plan_state === "active" || pro?.plan_state === "trial";

  mount.innerHTML =
    '<section class="surface block" aria-labelledby="plan-title">' +
    '<h2 id="plan-title">Plan</h2>' +
    planMarkup(pro) +
    "</section>" +
    '<section class="surface block" aria-labelledby="devices-title">' +
    '<h2 id="devices-title">Devices</h2>' +
    '<p class="note tight">Pro runs on up to five devices at once. Signing out a device leaves everything on it working locally.</p>' +
    devicesMarkup(devices, cap) +
    "</section>" +
    '<section class="surface block" aria-labelledby="history-title">' +
    '<h2 id="history-title">History and forecast</h2>' +
    (isPro
      /* The heading above already says what this is. A placeholder that
         repeats it spends a line telling a person something they have just
         read, so it states the one thing they cannot see instead. */
      ? '<div class="placeholder"><span>Charts appear once the hosted service has more than one day to draw. Nothing is estimated across a period that was not observed.</span></div>'
      : '<div class="placeholder"><span>The current reading is Free and always on. Pro keeps ninety days of it privately and projects when a budget will be reached.</span></div>') +
    "</section>";

  wirePro();
}

export async function renderSpend(mount) {
  state.mount = mount;
  if (mount === null) return;

  const result = await apiSpendStatus();
  if (!result.ok && result.reason === BACKEND_ABSENT) {
    mount.innerHTML =
      '<section class="surface block"><h2>API spend</h2><p class="note">This build has no API spend backend yet.</p></section>';
    return;
  }

  const status = result.ok ? result.value : { sources: [], samples: [] };
  state.spend = status;
  const sources = status.sources ?? [];
  const samples = status.samples ?? [];
  const hasAccepted = accepted();

  const sampleFor = (source) =>
    samples.find((sample) => sample.provider === source.provider) ?? null;

  mount.innerHTML =
    eligibilityMarkup() +
    keyFormMarkup() +
    (sources.length === 0
      ? hasAccepted
        ? '<section class="surface block"><h2>Connected keys</h2><p class="note">No key is stored yet. Add one above and the current reading appears here.</p></section>'
        : ""
      : '<section class="surface block" aria-labelledby="spend-sources-title">' +
        '<div class="block-head"><h2 id="spend-sources-title">Connected keys</h2>' +
        (status.localDisplayIsFree === true
          ? '<span class="badge" data-tone="ok">Local display is free</span>'
          : "") +
        "</div>" +
        '<div class="stack">' +
        sources.map((source) => sourceMarkup(source, sampleFor(source))).join("") +
        "</div>" +
        '<p class="note">OpenLimiter reads these on its own schedule, at most once every fifteen minutes per key. A manual refresh inside that window is declined rather than queued.</p>' +
        "</section>");

  if (hasAccepted) {
    document.getElementById("spend-accept")?.setAttribute("hidden", "");
    document.getElementById("spend-form")?.removeAttribute("hidden");
  }
  wireSpend();
}

function wirePro() {
  document.getElementById("pro-start-trial")?.addEventListener("click", async () => {
    await proService("start_trial", {});
    await renderPro(state.mount);
  });
  document.getElementById("pro-refresh-plan")?.addEventListener("click", async () => {
    await proStatus();
    await renderPro(state.mount);
  });
  document.getElementById("pro-revoke-others")?.addEventListener("click", async () => {
    await proService("revoke_other_devices", {});
    await renderPro(state.mount);
  });
  for (const control of document.querySelectorAll("[data-revoke]")) {
    control.addEventListener("click", async () => {
      await proService("revoke_device", { device_id: control.getAttribute("data-revoke") });
      await renderPro(state.mount);
    });
  }
}

function wireSpend() {
  document.getElementById("spend-accept")?.addEventListener("click", () => {
    try {
      globalThis.localStorage.setItem(ACCEPTED_KEY, String(CONSENT_VERSION));
    } catch (error) {
      /* Storage refused. The form still opens for this window. */
    }
    document.getElementById("spend-accept")?.setAttribute("hidden", "");
    document.getElementById("spend-form")?.removeAttribute("hidden");
    document.getElementById("spend-provider")?.focus();
  });

  const provider = document.getElementById("spend-provider");
  provider?.addEventListener("change", () => {
    const chosen = PROVIDERS.find((entry) => entry.id === provider.value);
    const note = document.getElementById("spend-provider-note");
    if (note !== null && chosen !== undefined) note.textContent = chosen.eligibility;
    const team = document.getElementById("spend-team-field");
    if (team !== null) team.hidden = chosen?.team !== true;
    const budget = document.getElementById("spend-budget");
    /* Moonshot is a balance. A budget on it would be the monthly spend
       conversion the contract forbids, so the field goes away entirely. */
    if (budget !== null) budget.disabled = chosen?.metric === "balance";
  });

  const confirm = document.getElementById("spend-confirm");
  const secret = document.getElementById("spend-secret");
  const save = document.getElementById("spend-save");
  const enableSave = () => {
    if (save === null) return;
    save.disabled = confirm?.checked !== true || (secret?.value ?? "") === "";
  };
  confirm?.addEventListener("change", enableSave);
  secret?.addEventListener("input", enableSave);

  save?.addEventListener("click", async () => {
    const note = document.getElementById("spend-note");
    const chosen = PROVIDERS.find((entry) => entry.id === provider?.value);
    const budget = document.getElementById("spend-budget")?.value ?? "";
    const result = await apiSpendSaveSource({
      provider: provider?.value,
      keyLabel: document.getElementById("spend-label")?.value ?? "",
      secret: secret?.value ?? "",
      ...(chosen?.team === true
        ? { teamId: document.getElementById("spend-team")?.value ?? "" }
        : {}),
      ...(budget.trim() === "" || chosen?.metric === "balance"
        ? {}
        : { budgetUsd: budget.trim() }),
      consentVersion: CONSENT_VERSION,
      confirmed: true,
    });
    if (secret !== null) secret.value = "";
    enableSave();
    if (note !== null) {
      note.textContent = result.ok
        ? "Saved. The key is in the keyring and the first reading follows within fifteen minutes."
        : "That key was not saved. " + (result.message ?? "");
    }
    if (result.ok) await renderSpend(state.mount);
  });

  document.getElementById("spend-cancel")?.addEventListener("click", () => {
    if (secret !== null) secret.value = "";
    document.getElementById("spend-form")?.setAttribute("hidden", "");
    document.getElementById("spend-accept")?.removeAttribute("hidden");
  });

  for (const control of document.querySelectorAll("[data-spend-refresh]")) {
    control.addEventListener("click", async () => {
      const result = await apiSpendRefresh(
        control.getAttribute("data-spend-refresh"),
        true
      );
      const note = document.getElementById("spend-note");
      /* Rust owns the cadence. A too soon answer is reported, never retried
         behind a person's back, because a hidden retry is how a client ends
         up rate limited by a provider it does not control. */
      if (result.ok && result.value?.kind === "too_soon" && note !== null) {
        note.textContent =
          "Too soon. OpenLimiter reads each key at most once every fifteen minutes.";
        return;
      }
      await renderSpend(state.mount);
    });
  }

  for (const control of document.querySelectorAll("[data-spend-remove]")) {
    control.addEventListener("click", async () => {
      await apiSpendRemoveSource(control.getAttribute("data-spend-remove"), false);
      await renderSpend(state.mount);
    });
  }
}
