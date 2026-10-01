/**
 * The Pro plan, and the API keys on the one screen.
 *
 * Both are where a person meets the paid layer, and both keep the same
 * promise: nothing functional and local is behind the plan. The plan card
 * sells hosted work and more than one account; it never sells a meter. The
 * key rows draw the local API money, which is Free, so nothing here checks an
 * entitlement before drawing an amount.
 *
 * The key rows say as little as works (Lucas, 2026-10-01): a field with a one
 * to three word placeholder, Save, a Get key link, then the amount with its
 * real period, its currency and its age. Saving is the consent, so one line
 * above the first Save says what it does, and Save sends that line's version.
 * Contract 4.2's long eligibility sentences are retired by that instruction;
 * an ineligible key gets one short line that says what to do instead.
 *
 * OpenRouter's field is its quota connection (connect_provider, the `$`
 * balance on its row), never an API spend source: one Save, one store. The
 * other five are API spend sources, and each source shows only its own
 * samples, matched by source and never by provider.
 *
 * The UI never runs its own poll. Rust owns the cadence, so a manual refresh
 * reports a too soon answer rather than retrying behind it.
 */
import { proCheckoutUrl, proPortalUrl, proRefresh, proService, proStatus, BACKEND_ABSENT } from "./backend.js";
import { updatedLabel } from "./names.js";

/* Keyed by the feature codes a signed token carries (pro.rs). Current usage
   sync between devices is free, so it is not listed. */
export const FEATURES = [
  { key: "multi_account", label: "More than one account per provider" },
  { key: "history", label: "Ninety days of private hosted history" },
  { key: "api_spend_beta", label: "Spend forecast from observed periods" },
  { key: "alerts", label: "Alerts that arrive with the app closed" },
  { key: "routing", label: "Live budget context for coding agent routing" },
  { key: "theme_preset", label: "Theme presets" },
];

/* The service says trialing; this window has always said trial. Both are
   listed so a plan state never renders as its own raw code. */
const PLAN_NAMES = {
  free: "Free",
  active: "Pro",
  trial: "Pro trial",
  trialing: "Pro trial",
  past_due: "Pro, payment failed",
  canceled: "Pro, ending",
  comped: "Pro",
};

const TRIAL_STATES = new Set(["trial", "trialing"]);
/* The states pro_status reports while a verified token is inside its signed
   window. Rust empties the features outside it. */
const ENTITLED_STATES = new Set(["active", "refresh_due", "grace"]);

/**
 * Whether the validated status unlocks Pro on this machine.
 *
 * Read from the verified state and its features, never from the plan name:
 * a past due plan is Pro until its signed window closes, and an expired
 * token still names the plan it once had.
 */
export function proEntitled(pro) {
  return ENTITLED_STATES.has(pro?.state) && Array.isArray(pro?.features) && pro.features.length > 0;
}

export const PRO_CHANGED = "openlimiter:pro-changed";

/** Ask the service for a fresh entitlement, then let every gated control repaint. */
export async function refreshEntitlement(api = { proRefresh }, target = globalThis) {
  const result = await api.proRefresh();
  /* The service moved this device's token chain past what it holds. Nothing
     here repairs that by itself, so the plan card offers Reconnect and
     keeps saying it until a refresh succeeds. */
  card.staleGrant = !result.ok && result.kind === "stale_grant";
  target.dispatchEvent(new CustomEvent(PRO_CHANGED));
  return result;
}

/**
 * Whole days left in a trial, from the instant the service reported.
 *
 * The server starts the trial and this window never starts one, so this is a
 * reading rather than a decision. A trial whose end is in the past reads as
 * zero rather than as a negative number nobody can act on.
 */
export function trialDaysRemaining(trialEndsAt, now = Date.now()) {
  const at = Date.parse(String(trialEndsAt ?? ""));
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 86_400_000));
}

/** "Pro trial, 12 days left", said the way a person counts days. */
export function trialSentence(days) {
  if (days === null) return "Pro trial running";
  if (days === 0) return "Pro trial, ending today";
  if (days === 1) return "Pro trial, 1 day left";
  return "Pro trial, " + String(days) + " days left";
}

const TICK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.4 8.4 3 3 6.2-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const LOCK =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.4" y="7" width="9.2" height="6.6" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/* ---------------------------------------------------------------- the plan */

/**
 * The plan card the menu shows: its name, what it holds, and its one way on.
 * A stale grant (the service moved this device's token chain) leads with one
 * line and Reconnect; app.js handles the press without revoking anything.
 */
export function planMarkup(pro, trialDays, staleGrant = false) {
  const isPro = proEntitled(pro);
  const planState = isPro ? (pro.plan_state ?? "active") : "free";
  const name = TRIAL_STATES.has(planState) ? trialSentence(trialDays) : (PLAN_NAMES[planState] ?? planState);
  return (
    '<div class="plan-card" data-state="' + escapeText(planState) + '" id="pro-plan">' +
    (staleGrant
      ? '<div class="plan-stale"><strong>Pro needs to reconnect</strong>' +
        '<button type="button" class="primary" id="pro-reconnect">Reconnect</button></div>'
      : "") +
    '<div class="plan-headline"><span class="plan-name">' + escapeText(name) + "</span>" +
    (isPro ? '<span class="badge" data-tone="accent">Active</span>' : "") +
    "</div>" +
    '<ul class="feature-list">' +
    FEATURES.map((feature) => {
      const on = pro?.[feature.key] === true || (pro?.features ?? []).includes(feature.key);
      return '<li data-on="' + String(on) + '">' + (on ? TICK : LOCK) + "<span>" + escapeText(feature.label) + "</span></li>";
    }).join("") +
    "</ul>" +
    '<div class="button-row">' +
    (isPro
      ? '<button type="button" id="pro-portal">Manage billing</button>' +
        '<button type="button" id="pro-refresh-plan">Refresh</button>'
      /* The client never starts a trial or a price. Checkout is hosted, and
         two buttons keep the yearly price as findable as the monthly one. */
      : '<button type="button" class="primary" id="pro-upgrade-monthly">Pro, $5 a month</button>' +
        '<button type="button" id="pro-upgrade-yearly">$50 a year</button>') +
    "</div>" +
    '<p class="note tight" id="pro-billing-note" role="status"></p>' +
    "</div>"
  );
}

/* The service does not say which kind of device a grant is, so a row says
   when it was last seen instead of guessing. */
export function lastSeen(device) {
  return typeof device.last_seen_at === "number"
    ? "Last seen " + new Date(device.last_seen_at).toLocaleString()
    : "Not seen yet";
}

export function devicesMarkup(devices, cap) {
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
          "</strong><span>" +
          escapeText(lastSeen(device)) +
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

const card = { mount: null, staleGrant: false };

/** The menu's plan block: the card, then the Pro devices when there are any. */
export async function renderPro(mount) {
  card.mount = mount;
  if (mount === null) return;

  const [proResult, devicesResult, accountResult] = await Promise.all([
    proStatus(),
    proService("device_status", {}),
    proService("account_status", {}),
  ]);

  if (!proResult.ok && proResult.reason === BACKEND_ABSENT) {
    mount.innerHTML = '<p class="note">Plan unavailable in this build.</p>';
    return;
  }

  const pro = proResult.ok ? proResult.value : null;
  const devices = devicesResult.ok ? (devicesResult.value?.devices ?? []) : [];
  /* The trial's end is the service's fact, read here and never invented. A
     window with no answer says "Pro trial running" rather than a made up
     number of days. */
  const trialDays = accountResult.ok
    ? trialDaysRemaining(accountResult.value?.entitlement?.trial_ends_at)
    : null;

  mount.innerHTML =
    planMarkup(pro, trialDays, card.staleGrant) +
    (devices.length === 0 ? "" : '<div class="plan-devices">' + devicesMarkup(devices, pro?.device_cap ?? 1) + "</div>");

  wirePro();
}

function billingNote(sentence) {
  const note = document.getElementById("pro-billing-note");
  if (note !== null) note.textContent = sentence;
}

function wirePro() {
  for (const [id, plan] of [
    ["pro-upgrade-monthly", "monthly"],
    ["pro-upgrade-yearly", "yearly"],
  ]) {
    document.getElementById(id)?.addEventListener("click", async () => {
      billingNote("Opening Checkout in your browser.");
      const result = await proCheckoutUrl(plan);
      billingNote(result.ok ? "Checkout is open in your browser." : (result.message ?? "Checkout could not be opened."));
    });
  }
  document.getElementById("pro-portal")?.addEventListener("click", async () => {
    const result = await proPortalUrl("manage");
    if (!result.ok) billingNote(result.message ?? "Billing could not be opened.");
  });
  document.getElementById("pro-refresh-plan")?.addEventListener("click", async () => {
    await refreshEntitlement();
  });
  document.getElementById("pro-revoke-others")?.addEventListener("click", async () => {
    await proService("revoke_other_devices", {});
    await renderPro(card.mount);
  });
  for (const control of document.querySelectorAll("[data-revoke]")) {
    control.addEventListener("click", async () => {
      await proService("revoke_device", { device_id: control.getAttribute("data-revoke") });
      await renderPro(card.mount);
    });
  }
}

/* ---------------------------------------------------------------- API keys */

/**
 * The one line above the first Save, and the version Save sends with
 * `confirmed`. A change to the line is a new version (version 1 was contract
 * 4.2's disclosure).
 */
export const KEY_CONSENT = Object.freeze({
  version: 2,
  text: "Saving lets OpenLimiter check this provider's billing. Keys stay on this device.",
});

/* One row each, in this order. `mark` is the provider code whose official
   mark the row wears; DeepSeek has none here, so it wears its initial. */
export const KEY_PROVIDERS = Object.freeze([
  { id: "openrouter", name: "OpenRouter", mark: "OPENROUTER", placeholder: "API key", url: "https://openrouter.ai/settings/keys" },
  { id: "openai", name: "OpenAI", mark: "CODEX", placeholder: "Admin key", url: "https://platform.openai.com/settings/organization/admin-keys" },
  { id: "anthropic", name: "Anthropic", mark: "CLAUDE", placeholder: "Admin key", url: "https://console.anthropic.com/settings/admin-keys" },
  { id: "xai", name: "xAI", mark: "GROK", placeholder: "Management key", team: true, url: "https://console.x.ai" },
  { id: "moonshot", name: "Moonshot", mark: "KIMI", placeholder: "API key", url: "https://platform.moonshot.ai/console/api-keys" },
  { id: "deepseek", name: "DeepSeek", mark: null, initial: "D", placeholder: "API key", url: "https://platform.deepseek.com/api_keys" },
]);

// English catalog for the key rows. L7 owns translations.
export const KEYS_EN = Object.freeze({
  save: "Save",
  getKey: "Get key",
  team: "Team ID",
  checking: "Checking key",
  saved: "Key saved",
  refresh: "Refresh {name}",
  remove: "Remove {name}",
  confirmRemove: "Press again to remove {name}",
  incomplete: "Incomplete",
  unavailable: "Unavailable",
  tooLow: "Too low for API calls",
  cny: "Reported in CNY",
  thisMonth: "spent this month",
  lastMonth: "last month",
  inMonth: "spent in {month}",
  balance: "balance",
});

const fill = (text, values) => text.replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ""));

/* A key the provider refused, by what kind of key each one wants. */
const REFUSED_KEY = {
  openai: "Project key won't work, use an Admin key",
  anthropic: "Workspace key won't work, use an Admin key",
  xai: "Wrong key or team ID",
};

/**
 * One short line that says what to do, for a refusal on Save (the backend's
 * failure kind) or a source's stored status.
 */
export function keyError(provider, kind) {
  switch (kind) {
    case "ineligible_or_revoked":
    case "unauthorized":
      return REFUSED_KEY[provider] ?? "Key not accepted, paste a new one";
    case "invalid_input":
      return provider === "xai" ? "Wrong team ID" : "Check the key and save again";
    case "keyring_unavailable":
      return "Keyring unavailable, try again";
    case "rate_limited":
      return "Rate limited, try again later";
    case "too_soon":
      return "Try again in a few minutes";
    case "storage":
      return "Could not save, try again";
    default:
      return "Could not reach the provider, try again";
  }
}

/* Statuses that keep the key but could not read it this time. */
const UNAVAILABLE = new Set(["rate_limited", "temporarily_unavailable", "response_drift", "unsafe_destination"]);
/* Completeness words that are not a whole period (api_spend.rs). */
const PARTIAL = new Set(["period_incomplete", "since_connected"]);
/* Connection states in which OpenRouter's stored key cannot read. */
const KEY_REFUSED = new Set(["NEEDS_AUTH", "AUTH_EXPIRED"]);

const money = (amount) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(amount));

/**
 * What period an amount covers, from the sample's own month (a UTC month,
 * as Rust stamps it): this month, last month, an older month by name, or a
 * balance, which has no period. Last month is never called this month.
 */
export function periodLabel(sample, now) {
  if (sample?.metricKind === "balance") return KEYS_EN.balance;
  const [year, month] = String(sample?.month ?? "").split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return "";
  const at = new Date(now);
  const current = at.getUTCFullYear() * 12 + at.getUTCMonth();
  const observed = year * 12 + (month - 1);
  if (observed === current) return KEYS_EN.thisMonth;
  if (observed === current - 1) return KEYS_EN.lastMonth;
  const name = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(Date.UTC(year, month - 1, 1));
  return fill(KEYS_EN.inMonth, { month: name });
}

function spendRow(base, source, sample, many, now) {
  const row = { ...base, kind: "spend", sourceId: source.id, keyLabel: source.keyLabel, label: many ? source.keyLabel : null };
  if (source.status === "ineligible_or_revoked") {
    return { ...row, state: "error", error: keyError(base.provider, source.status), replace: true };
  }
  if (source.status === "keyring_unavailable") return { ...row, state: "error", error: keyError(base.provider, source.status) };
  const badges = [
    ...(source.status === "observed_incomplete" || (sample?.metricKind === "spend" && PARTIAL.has(sample.completeness)) ? [KEYS_EN.incomplete] : []),
    ...(UNAVAILABLE.has(source.status) ? [KEYS_EN.unavailable] : []),
    ...(source.status === "too_low_for_api_calls" ? [KEYS_EN.tooLow] : []),
  ];
  if (sample === null) return badges.length ? { ...row, state: "reading", badges } : { ...row, state: "checking" };
  const age = updatedLabel(sample.observedAt, now);
  const shown = sample.displayState ?? {};
  /* Rust never converts a currency, so a yuan only balance has no amount. */
  if (shown.kind === "reportedInCny") return { ...row, state: "reading", cny: true, age, badges };
  if (typeof shown.amountUsd !== "string") return { ...row, state: "reading", age, badges };
  return { ...row, state: "reading", amount: money(shown.amountUsd), period: periodLabel(sample, now), currency: "USD", age, badges };
}

function quotaRow(base, openrouter, now) {
  const records = openrouter?.records ?? [];
  if (records.length === 0) return { ...base, state: "empty" };
  const record = records.find((entry) => entry.state === "CONNECTED") ?? records[0];
  const row = { ...base, recordId: record.id };
  /* A refused key is replaced right there; app.js removes the old record first. */
  if (KEY_REFUSED.has(record.state)) return { ...row, state: "error", error: keyError("openrouter", "ineligible_or_revoked"), replace: true };
  if (record.state === "ERROR") return { ...row, state: "error", error: keyError("openrouter", "network"), replace: true };
  const reading = openrouter?.reading ?? null;
  if (reading !== null && Number.isFinite(reading.usedAmount) && Number.isFinite(reading.limitAmount)) {
    return {
      ...row, state: "reading", amount: money(Math.max(0, reading.limitAmount - reading.usedAmount)),
      period: KEYS_EN.balance, currency: reading.currency ?? "USD", age: updatedLabel(reading.observedAt, now),
    };
  }
  return { ...row, state: record.state === "CONNECTED" ? "saved" : "checking" };
}

/**
 * One row per key provider, from the spend status (`api_spend_status`) and
 * OpenRouter's quota connection: its records and its newest money reading.
 * A provider with two sources gets two rows, each with its own newest sample.
 */
export function keyRows({ status = null, openrouter = null } = {}, now) {
  const sources = status?.sources ?? [];
  const samples = status?.samples ?? [];
  const newest = (id) => samples
    .filter((sample) => sample.sourceId === id)
    .reduce((held, sample) => (held === null || Date.parse(sample.observedAt) > Date.parse(held.observedAt) ? sample : held), null);
  return KEY_PROVIDERS.flatMap((provider) => {
    const base = { ...provider, provider: provider.id, kind: "spend", badges: [] };
    const own = sources.filter((source) => source.provider === provider.id);
    if (provider.id === "openrouter") {
      /* A 2.0.2 OpenRouter spend source keeps its own row under the key. */
      return [quotaRow({ ...base, kind: "quota" }, openrouter, now), ...own.map((source) => spendRow(base, source, newest(source.id), true, now))];
    }
    if (own.length === 0) return [{ ...base, state: "empty" }];
    return own.map((source) => spendRow(base, source, newest(source.id), own.length > 1, now));
  });
}

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const REFRESH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M13.2 8A5.2 5.2 0 1 1 11.7 4.3" /><path d="M13 2.2v3.1H9.9" /></svg>';
const REMOVE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg>';

function iconButton(doc, action, label, icon) {
  const button = element(doc, "button", "q-iconbtn");
  button.type = "button";
  button.dataset.keyAction = action;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.innerHTML = icon;
  return button;
}

/* The field, Save and Get key, on an empty row or a refused one. */
function keyForm(doc, row, handlers, status) {
  const form = element(doc, "div", "q-kform");
  const input = element(doc, "input", "q-kfield");
  input.type = "password";
  input.dataset.field = "secret";
  input.setAttribute("placeholder", row.placeholder);
  input.setAttribute("aria-label", row.name + " " + row.placeholder);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  form.append(input);
  let team = null;
  if (row.team) {
    team = element(doc, "input", "q-kfield q-kteam");
    team.type = "text";
    team.dataset.field = "team";
    team.setAttribute("placeholder", KEYS_EN.team);
    team.setAttribute("aria-label", row.name + " " + KEYS_EN.team);
    team.setAttribute("autocomplete", "off");
    team.setAttribute("spellcheck", "false");
    form.append(team);
  }
  const save = element(doc, "button", "q-btn q-btn-primary", KEYS_EN.save);
  save.type = "button";
  save.dataset.keyAction = "save";
  save.addEventListener("click", async () => {
    const secret = String(input.value ?? "").trim();
    /* Cleared before anything is sent, so a secret never waits in a field. */
    input.value = "";
    if (secret === "" || save.disabled) return;
    save.disabled = true;
    status.textContent = "";
    let result;
    try {
      result = row.kind === "quota"
        ? await handlers.saveOpenrouter(secret)
        : await handlers.save({
          provider: row.provider,
          keyLabel: row.keyLabel ?? row.name,
          secret,
          ...(row.team ? { teamId: String(team.value ?? "").trim() } : {}),
          ...(row.sourceId ? { sourceId: row.sourceId } : {}),
          consentVersion: KEY_CONSENT.version,
          confirmed: true,
        });
    } catch {
      result = { ok: false };
    }
    save.disabled = false;
    if (!result?.ok) status.textContent = keyError(row.provider, result?.kind);
  });
  const link = element(doc, "a", "q-klink", KEYS_EN.getKey);
  link.setAttribute("href", row.url);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  form.append(save, link);
  return form;
}

/* What a saved key shows: checking, saved, or two lines: the amount with its
   period, then its currency, its age and any badge that is true. */
function keyValue(doc, row) {
  const value = element(doc, "div", "q-kvalue");
  if (row.state === "checking" || row.state === "saved") {
    value.append(element(doc, "span", "q-tnote", row.state === "checking" ? KEYS_EN.checking : KEYS_EN.saved));
    return value;
  }
  const line = element(doc, "div", "q-kline");
  if (row.amount) line.append(element(doc, "b", "q-kamount", row.amount), element(doc, "span", "q-kperiod", row.period));
  if (row.cny) line.append(element(doc, "b", "q-kamount", KEYS_EN.cny));
  const meta = element(doc, "div", "q-kmeta");
  if (row.amount) meta.append(element(doc, "span", "q-kmetaitem", row.currency));
  if (row.age) meta.append(element(doc, "span", "q-kmetaitem", row.age));
  for (const badge of row.badges) meta.append(element(doc, "span", "q-kbadge", badge));
  value.append(...[line, meta].filter((part) => part.children.length > 0));
  return value;
}

/* Remove asks twice: the second press within four seconds is the yes. */
function removeButton(doc, row, handlers, status) {
  const label = fill(KEYS_EN.remove, { name: row.name });
  const button = iconButton(doc, "remove", label, REMOVE_ICON);
  let armed = null;
  button.addEventListener("click", async () => {
    if (armed === null) {
      button.dataset.confirm = "";
      button.setAttribute("aria-label", fill(KEYS_EN.confirmRemove, { name: row.name }));
      armed = globalThis.setTimeout?.(() => {
        armed = null;
        delete button.dataset.confirm;
        button.setAttribute("aria-label", label);
      }, 4_000) ?? 0;
      return;
    }
    globalThis.clearTimeout?.(armed);
    armed = null;
    button.disabled = true;
    const result = await handlers.remove(row);
    button.disabled = false;
    if (!result?.ok) status.textContent = keyError(row.provider, result?.kind);
  });
  return button;
}

/** Draw keyRows: one consent line above the first Save, then a row per key. */
export function renderKeys(doc, mount, rows, handlers) {
  const consent = element(doc, "p", "q-note q-consent", KEY_CONSENT.text);
  consent.id = "key-consent";
  const asks = rows.some((row) => row.state === "empty" || row.replace === true);
  mount.replaceChildren(...(asks ? [consent] : []), ...rows.map((row) => {
    const line = element(doc, "div", "q-key");
    line.dataset.keyRow = row.provider;
    line.dataset.state = row.state;
    const mark = element(doc, "span", "q-mark");
    mark.setAttribute("aria-hidden", "true");
    if (row.mark) {
      mark.dataset.provider = row.mark;
      mark.innerHTML = handlers.markFor(row.mark);
    } else {
      mark.textContent = row.initial;
    }
    const name = element(doc, "span", "q-kname", row.name);
    if (row.label) name.append(element(doc, "span", "q-klabel", row.label));
    const status = element(doc, "p", "q-kerror");
    status.setAttribute("role", "status");
    if (row.error) status.textContent = row.error;
    const body = row.state === "empty" || row.replace ? keyForm(doc, row, handlers, status)
      : row.state === "error" ? element(doc, "div", "q-kvalue") : keyValue(doc, row);
    const tail = element(doc, "div", "q-kact");
    if (["reading", "saved", "checking"].includes(row.state)) {
      const refresh = iconButton(doc, "refresh", fill(KEYS_EN.refresh, { name: row.name }), REFRESH_ICON);
      refresh.addEventListener("click", async () => {
        refresh.disabled = true;
        refresh.setAttribute("aria-busy", "true");
        const result = await handlers.refresh(row);
        refresh.disabled = false;
        refresh.setAttribute("aria-busy", "false");
        if (!result?.ok) status.textContent = keyError(row.provider, result?.kind);
      });
      tail.append(refresh);
    }
    if (row.state !== "empty") tail.append(removeButton(doc, row, handlers, status));
    line.append(mark, name, body, tail, status);
    return line;
  }));
}
