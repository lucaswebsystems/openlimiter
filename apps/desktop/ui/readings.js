/*
 * What a reading looks like on screen, once, for Home and the edge panel.
 *
 * Both surfaces run what the native side hands them through projectReadings
 * and draw it with renderLimits (and their agents with agents.js). The panel
 * can therefore never disagree with Home about which rows exist, what they are
 * called or which band they sit in. Connections draws its Needs attention rows
 * from here too, with the same names and marks.
 *
 * Nothing read off disk reaches innerHTML: the only markup set that way is
 * the constant artwork of a provider mark, a band shape or a state icon.
 */
import {
  dedupeFailures,
  freshness,
  mergeSnapshots,
  normalizeMetersReport,
  projectSnapshots,
  readSuppressions,
  visibleSnapshots,
} from "./engine/core/index.js";
import { parseManualPayload } from "./engine/connectors/manual.js";
import { bandForPercent, bandIconSvg, closestToLimit, providerMarkMarkup, windowRank } from "./engine/ui/provider-row.js";
import { duration, meterLabel, providerAccess, providerCode, providerName, say } from "./names.js";

function parseJson(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  try { return JSON.parse(text); } catch { return null; }
}

/* The five fixes, in the order a person should take them. */
export const FIX_KINDS = Object.freeze(["switch_on", "sign_in", "reconnect", "open_app", "unsupported"]);

function readFlags(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((flag) => flag && typeof flag.provider === "string" && typeof flag.reason === "string" &&
    FIX_KINDS.includes(flag.fixKind) ? [{ provider: providerCode(flag.provider), reason: flag.reason, fixKind: flag.fixKind }] : []);
}

/**
 * Everything displayable right now, and everything that is not, as flags.
 *
 * `cacheText` is what read_cache returned: rows the native data rules already
 * projected, plus their flags. `manualText` is the manual document, which never
 * passed through native code. Every row goes through the one TypeScript twin of
 * the data rules on the way in, so a row the native side already accepted
 * passes unchanged and nothing that skipped it can bring a hidden row back.
 */
export function projectReadings(cacheText, manualText, now) {
  const failures = [];
  const cached = parseJson(cacheText);
  let rows = [];
  let flags = [];
  if (cached !== null && Array.isArray(cached.snapshots)) {
    const report = normalizeMetersReport(cached.snapshots);
    for (const provider of report.rejected) failures.push({ provider, category: "VALIDATION_REJECTED" });
    const suppressions = readSuppressions(cached.suppressions);
    if (suppressions.ok) {
      rows = visibleSnapshots({ snapshots: report.snapshots, suppressions: suppressions.suppressions });
      for (const suppression of suppressions.suppressions) failures.push({ provider: suppression.provider, category: "PROVIDER_DRIFT" });
    } else {
      // An unreadable suppression list cannot prove any cached row is still trustworthy.
      for (const provider of new Set(report.snapshots.map((row) => row.provider))) failures.push({ provider, category: "PROVIDER_DRIFT" });
    }
    flags = readFlags(cached.flags);
  }
  const manual = parseJson(manualText);
  if (manual !== null) {
    const report = normalizeMetersReport(parseManualPayload(manual, now) ?? []);
    rows = mergeSnapshots(rows, report.snapshots);
    for (const provider of report.rejected) failures.push({ provider, category: "VALIDATION_REJECTED" });
  } else if (typeof manualText === "string" && manualText.trim() !== "") {
    failures.push({ provider: "MANUAL", category: "PAYLOAD_UNREADABLE" });
  }
  const projected = projectSnapshots(rows, now);
  return { snapshots: projected.snapshots, flags: [...flags, ...readFlags(projected.flags)], failures: dedupeFailures(failures) };
}

/** Providers a person switched off: native flags them, the window may remember more. */
export function switchedOff(flags, removed = []) {
  return new Set([...removed.map(providerCode), ...flags.filter((flag) => flag.fixKind === "switch_on").map((flag) => flag.provider)]);
}

/**
 * What is still displayable of rows already on screen, at `now`. When a read
 * fails the window keeps only these, so expired rows leave by the one
 * freshness policy instead of freezing where they were.
 */
export function holdReadings(snapshots, now) {
  return projectSnapshots(snapshots, now).snapshots;
}

/**
 * One Needs attention entry per provider that shows nothing, with its most
 * useful fix. A provider that still shows a measured row is not flagged: an old
 * account's leftovers are storage, not something a person has to act on. A
 * provider switched off is not flagged at all: that was the person's choice,
 * and its switch stays in the catalogue.
 */
export function attentionFlags(flags, snapshots, removed = []) {
  const shown = new Set(snapshots.map((row) => providerCode(row.provider)));
  const off = switchedOff(flags, removed);
  const best = new Map();
  for (const flag of flags) {
    const held = best.get(flag.provider);
    if (shown.has(flag.provider) || off.has(flag.provider) ||
        (held && FIX_KINDS.indexOf(held.fixKind) <= FIX_KINDS.indexOf(flag.fixKind))) continue;
    best.set(flag.provider, flag);
  }
  return [...best.values()].sort((left, right) => FIX_KINDS.indexOf(left.fixKind) - FIX_KINDS.indexOf(right.fixKind) ||
    providerName(left.provider).localeCompare(providerName(right.provider)));
}

/**
 * Connected: every provider switched on that is measured right now, detected
 * with a login on this computer, or connected by a key, and not waiting in
 * Needs attention. `detections` and `connections` are the native reports.
 */
export function connectedProviders({ snapshots, detections = null, connections = [], flags = [], removed = [], attention = [] }) {
  const off = switchedOff(flags, removed);
  const flagged = new Set(attention.map((flag) => flag.provider));
  const codes = new Set([
    ...snapshots.map((row) => providerCode(row.provider)),
    ...(detections?.providers ?? []).filter((entry) => entry.state === "present").map((entry) => providerCode(entry.provider_id)),
    ...connections.filter((entry) => entry.state === "CONNECTED").map((entry) => providerCode(entry.provider)),
  ]);
  return [...codes].filter((code) => code && !off.has(code) && !flagged.has(code))
    .map((code) => ({ code, name: providerName(code), access: providerAccess(code) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

const SOURCE_KEYS = Object.freeze({ automatic: "sourceLocal", key: "sourceKey", manual: "sourceManual" });

/** Connected rows: mark, name, where the numbers come from, and a green check. */
export function renderConnected(doc, mount, providers) {
  mount.replaceChildren(...providers.map((provider) => {
    const row = node(doc, "div", "q-conn");
    row.setAttribute("role", "listitem");
    row.dataset.connectedRow = "";
    row.dataset.provider = provider.code;
    const text = node(doc, "div", "q-ftext");
    text.append(node(doc, "div", "q-fname-text", provider.name),
      node(doc, "p", "q-fdetail", say(SOURCE_KEYS[provider.access] ?? "sourceLocal", { name: provider.name })));
    const status = node(doc, "span", "q-ok");
    status.append(art(doc, "q-sico", CHECK_ICON), node(doc, "span", "", say("connected")));
    row.append(markNode(doc, provider.code), text, status);
    return row;
  }));
}

const money = (amount, currency) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);

/* "4d 14h", "1h 55m", "12m": the time left, never below a minute. An empty
   string means the reset instant already passed; null means none was stated. */
export function timeLeft(resetAt, now) {
  if (!resetAt) return null;
  const left = Date.parse(resetAt) - Date.parse(now);
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return "";
  return duration(Math.floor(left / 1000));
}

function windowView(row, now) {
  const hasMoney = Number.isFinite(row.usedAmount) && Number.isFinite(row.limitAmount) && typeof row.currency === "string";
  const unbounded = row.unit === "CREDITS" && !hasMoney;
  const usedPercent = unbounded ? null : Math.min(100, Math.max(0, row.value));
  const stale = freshness(row.observedAt, row.expiresAt, now) !== "fresh";
  return {
    key: row.meter,
    label: meterLabel(row.meter, row.provider),
    usedPercent,
    observedAt: row.observedAt,
    band: stale ? "stale" : usedPercent === null ? "none" : bandForPercent(usedPercent),
    value: hasMoney ? money(row.usedAmount, row.currency)
      : unbounded ? String(Math.floor(row.value * 100) / 100) : `${Math.floor(usedPercent)}%`,
    limit: hasMoney ? money(row.limitAmount, row.currency) : null,
    unbounded,
    reset: timeLeft(row.resetAt, now),
  };
}

/* Tightest first, by the one rule the Rail headline and the tray use. */
function tightestFirst(windows) {
  const rest = [...windows].sort((left, right) => windowRank(left.key) - windowRank(right.key) || left.key.localeCompare(right.key));
  const ordered = [];
  while (rest.length > 0) {
    const next = closestToLimit(rest);
    ordered.push(next);
    rest.splice(rest.indexOf(next), 1);
  }
  return ordered;
}

/**
 * One entry per provider, tightest window first and tightest provider first.
 *
 * The rows are already the active accounts only. If a provider still has two
 * (two accounts connected on purpose), they share its one card and the second
 * account's windows say so, by position, never by an id.
 */
export function limitsModel(snapshots, now) {
  const providers = new Map();
  /* The one projection decides what is still drawable at `now`: fresh rows,
     and a Claude status line row held, stale, until its window resets. */
  for (const row of projectSnapshots(snapshots, now).snapshots) {
    const code = providerCode(row.provider);
    const accounts = providers.get(code) ?? new Map();
    providers.set(code, accounts);
    const meters = accounts.get(row.accountId ?? "") ?? new Map();
    accounts.set(row.accountId ?? "", meters);
    const held = meters.get(row.meter);
    // Repeated observations of one window: the latest is the reading.
    if (!held || Date.parse(row.observedAt) > Date.parse(held.observedAt)) meters.set(row.meter, row);
  }
  const model = [...providers].map(([code, accounts]) => {
    const windows = [...accounts.keys()].sort().flatMap((account, index) => [...accounts.get(account).values()].map((row) => {
      const view = windowView(row, now);
      if (index === 0) return view;
      // The count stays on the line of its word: "account 2" never breaks before the 2.
      return { ...view, label: say("accountOrdinal", { label: view.label, count: index + 1 }).replace(/ (?=\d+$)/u, "\u00a0") };
    }));
    /* A held reading says how old it is, by its oldest stale window. */
    const stale = windows.filter((window) => window.band === "stale").map((window) => window.observedAt).sort();
    return { code, name: providerName(code), windows: tightestFirst(windows), age: stale.length ? updatedLabel(stale[0], now) : null };
  });
  const headline = (provider) => provider.windows[0]?.usedPercent ?? -1;
  return model.sort((left, right) => headline(right) - headline(left) || left.name.localeCompare(right.name));
}

function node(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/* Constant artwork: the check a Connected row ends with, and the alert circle
   a Needs attention row opens with. */
const CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2"/><path d="m5.3 8.2 1.9 1.9 3.6-3.9"/></svg>';
const ALERT_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.9v3.5"/><circle cx="8" cy="11" r=".6" fill="currentColor" stroke="none"/></svg>';

function art(doc, className, markup) {
  const element = node(doc, "span", className);
  element.setAttribute("aria-hidden", "true");
  element.innerHTML = markup;
  return element;
}

let gradients = 0;

/**
 * A provider's official mark, painted for any slot this window sizes: filled
 * in currentColor, or stroked for manual entry. Each copy gets its own
 * gradient ids, because a reference to a gradient inside a hidden tab draws
 * nothing at all.
 */
export function officialMark(provider) {
  const code = providerCode(provider);
  const markup = providerMarkMarkup(code) ?? "";
  if (!markup.startsWith("<svg")) return markup;
  const paint = code === "MANUAL"
    ? ' stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'
    : ' fill="currentColor"';
  const copy = ++gradients;
  return markup.replace("<svg", `<svg focusable="false"${paint}`)
    .replace(/ol-(antigravity|gemini)-gradient/gu, `ol-$1-gradient-${copy}`);
}

export function markNode(doc, provider) {
  const code = providerCode(provider);
  const mark = art(doc, "q-mark", officialMark(code));
  mark.dataset.provider = code;
  return mark;
}

function limitRow(doc, window, compact) {
  const row = node(doc, "div", "q-row");
  row.dataset.band = window.band;
  const bar = node(doc, "span", "q-bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", window.label);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  if (window.usedPercent !== null) bar.setAttribute("aria-valuenow", String(Math.floor(window.usedPercent)));
  bar.setAttribute("aria-valuetext", window.unbounded ? `${window.value} ${say("creditsSpent")}` : say("usedValue", { value: window.value }));
  const fill = node(doc, "i");
  fill.style?.setProperty("width", `${window.usedPercent ?? 0}%`);
  bar.append(fill);
  const value = node(doc, "span", "q-val");
  if (["yellow", "orange", "red"].includes(window.band)) value.append(art(doc, "q-shape", bandIconSvg(window.band)));
  value.append(node(doc, "span", "", compact || window.unbounded ? window.value : say("usedValue", { value: window.value })));
  const reset = window.limit !== null ? say("moneyOf", { amount: window.limit })
    : window.unbounded ? say("creditsSpent")
    : window.reset === null ? ""
    : window.reset === "" ? say(compact ? "now" : "resettingNow")
    : compact ? window.reset : say("resetsInValue", { time: window.reset });
  row.append(node(doc, "span", "q-lbl", window.label), bar, value, node(doc, "span", "q-rst", reset));
  return row;
}

/* The panel's column headings, over the percentage and the countdown. The bars
   already speak their values, so these are for the eye only. */
function columnHeads(doc) {
  const head = node(doc, "div", "q-colhead");
  head.setAttribute("aria-hidden", "true");
  head.append(node(doc, "span"), node(doc, "span"), node(doc, "span", "", say("used")), node(doc, "span", "", say("resetsIn")));
  return head;
}

/** Draw a limitsModel. `compact` is the panel's column form. */
export function renderLimits(doc, mount, model, { compact = false } = {}) {
  mount.replaceChildren(...(compact && model.length ? [columnHeads(doc)] : []), ...model.map((provider) => {
    const group = node(doc, "div", "q-group");
    group.dataset.providerCard = "";
    group.dataset.provider = provider.code;
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", provider.name);
    const head = node(doc, "div", "q-prov");
    head.append(markNode(doc, provider.code), node(doc, "span", "q-pname", provider.name));
    if (provider.age) head.append(node(doc, "span", "q-age", provider.age));
    group.append(head, ...provider.windows.map((window) => limitRow(doc, window, compact)));
    return group;
  }));
}

/** "Updated 3 min ago" for the freshest observation on screen. */
export function updatedLabel(instant, now) {
  const at = Date.parse(instant ?? "");
  if (!Number.isFinite(at)) return say("noReading");
  const minutes = Math.floor((Date.parse(now) - at) / 60_000);
  if (minutes < 1) return say("updatedJustNow");
  if (minutes < 60) return say("updatedMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? say("updatedHours", { count: hours }) : say("updatedDays", { count: Math.floor(hours / 24) });
}

/**
 * The words for one fix. `route` is "connect" when this window has its own
 * connect flow for the provider, "rescan" when the sign in lives in the tool
 * itself (the person signs in there, then checks again), or "none".
 */
export function fixWords(flag, route) {
  /* Two Claude states say what actually happened, not a generic refresh. */
  if (flag.reason === "account_unresolved") {
    return { issue: "fixSignInAgainIssue", detail: "fixToolDetail", action: route === "connect" ? "fixSignInAction" : "fixOpenAppAction" };
  }
  if (flag.reason === "awaiting_statusline") return { issue: "fixWaitingIssue", detail: "fixWaitingDetail", action: "fixOpenAppAction" };
  if (flag.fixKind === "unsupported" || route === "none") {
    return { issue: "fixUnsupportedIssue", detail: "fixUnsupportedDetail", action: null };
  }
  if (flag.fixKind === "open_app") return { issue: "fixOpenAppIssue", detail: "fixOpenAppDetail", action: "fixOpenAppAction" };
  const words = flag.fixKind === "sign_in" ? "SignIn" : "Reconnect";
  return route === "connect"
    ? { issue: `fix${words}Issue`, detail: `fix${words}Detail`, action: `fix${words}Action` }
    : { issue: `fix${words}Issue`, detail: "fixToolDetail", action: "fixOpenAppAction" };
}

/**
 * Needs attention: mark, name, one plain sentence and one fix. `route(flag)`
 * says how the fix works (see fixWords) and `fix(flag)` performs it, resolving
 * false when it did not work; an unsupported provider has nothing to press and
 * says so.
 */
export function renderAttention(doc, mount, flags, { fix, route = () => "rescan" }) {
  mount.replaceChildren(...flags.map((flag) => {
    const name = providerName(flag.provider);
    const words = fixWords(flag, route(flag));
    const row = node(doc, "div", "q-flag");
    row.setAttribute("role", "listitem");
    row.dataset.flagRow = "";
    row.dataset.provider = flag.provider;
    row.dataset.fixKind = flag.fixKind;
    const text = node(doc, "div", "q-ftext");
    const title = node(doc, "div", "q-fname");
    const issue = node(doc, "span", "q-issue");
    issue.append(art(doc, "q-sico", ALERT_ICON), node(doc, "span", "", say(words.issue, { name })));
    title.append(node(doc, "span", "q-fname-text", name), issue);
    const detail = node(doc, "p", "q-fdetail", say(words.detail, { name }));
    text.append(title, detail);
    if (words.action === null) {
      detail.dataset.fix = "unsupported";
    } else {
      const actions = node(doc, "div", "q-actions");
      const button = node(doc, "button", "q-btn q-btn-primary", say(words.action));
      button.type = "button";
      button.dataset.fix = flag.fixKind;
      const status = node(doc, "span", "q-fstatus");
      status.setAttribute("role", "status");
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        status.textContent = "";
        try {
          if ((await fix(flag)) === false) status.textContent = say("fixFailed");
        } catch {
          status.textContent = say("fixFailed");
        } finally {
          button.disabled = false;
          button.setAttribute("aria-busy", "false");
        }
      });
      actions.append(button, status);
      text.append(actions);
    }
    row.append(markNode(doc, flag.provider), text);
    return row;
  }));
}
