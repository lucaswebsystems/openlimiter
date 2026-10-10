/*
 * What a reading looks like on screen, once, for Home and the edge panel.
 *
 * Both surfaces run what the native side hands them through projectReadings
 * and draw it with renderLimits (and their agents with agents.js). The panel
 * can therefore never disagree with Home about which rows exist, what they are
 * called or which band they sit in. Home's one list adds a row for every tool
 * in play that has no reading yet, with the one step that gets it one.
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
import { duration, meterLabel, meterPresentation, meterRank, providerCode, providerName, say, updatedLabel } from "./names.js";

export { updatedLabel };

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

/**
 * The alert samples for the rows on screen: percentages, and fresh ones only.
 * A stale reading draws flat grey with its age, so it never raises an alert.
 */
export function alertSamples(snapshots, now) {
  return snapshots
    .filter((snapshot) => snapshot.unit === "PERCENT" && Number.isFinite(snapshot.value) &&
      freshness(snapshot.observedAt, snapshot.expiresAt, now) === "fresh")
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
}

/** Providers a person switched off: native flags them, the window may remember more. */
export function switchedOff(flags, removed = []) {
  return new Set([...removed.map(providerCode), ...flags.filter((flag) => flag.fixKind === "switch_on").map((flag) => flag.provider)]);
}

/**
 * What is still displayable of rows already on screen, at `now`. When a read
 * fails the window keeps only these: fresh rows, and stale rows the data rules
 * still hold, drawn grey with their age rather than frozen as if current.
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
  const presentation = meterPresentation(row.meter, row.provider);
  if (row.availability && presentation?.displayAvailability) {
    const noCap = row.availability === "unlimited" && row.meter === "KEY_LIMIT";
    const unlimitedCredits = row.provider === "CODEX" && row.meter === "CREDITS" && row.availability === "unlimited";
    return {
      key: row.meter,
      label: meterLabel(row.meter, row.provider),
      usedPercent: null,
      observedAt: row.observedAt,
      band: "none",
      value: say(noCap ? "noKeyCap" : unlimitedCredits ? "unlimitedCredits" : "unavailableScope"),
      limit: say(noCap ? "keyNoSpendingCap" : unlimitedCredits
        ? "creditBalanceLimitNotReported"
        : "managementKeyRequired"),
      unbounded: true,
      neutral: true,
      reset: null,
      moneyDetail: false,
    };
  }
  const hasMoney = Number.isFinite(row.usedAmount) && Number.isFinite(row.limitAmount) && typeof row.currency === "string";
  const balance = presentation?.valueSemantics === "balance";
  const unbounded = row.unit === "CREDITS" && !hasMoney && !balance;
  const usedPercent = unbounded ? null : Math.min(100, Math.max(0, row.value));
  const stale = freshness(row.observedAt, row.expiresAt, now) !== "fresh";
  return {
    key: row.meter,
    label: meterLabel(row.meter, row.provider),
    usedPercent: balance ? null : usedPercent,
    observedAt: row.observedAt,
    band: stale ? "stale" : balance || usedPercent === null ? "none" : bandForPercent(usedPercent),
    value: balance && hasMoney ? money(Math.max(0, row.limitAmount - row.usedAmount), row.currency)
      : balance ? say("creditsBalance", { value: String(Math.floor(row.value * 100) / 100) })
      : hasMoney ? money(row.usedAmount, row.currency)
      : unbounded ? String(Math.floor(row.value * 100) / 100)
      : `${Math.floor(usedPercent)}%`,
    limit: balance && hasMoney ? say("accountBalanceDetail", {
      purchased: money(row.limitAmount, row.currency),
      used: money(row.usedAmount, row.currency),
    })
      : hasMoney ? money(row.limitAmount, row.currency) : null,
    unbounded,
    neutral: balance,
    reset: timeLeft(row.resetAt, now),
    moneyDetail: Boolean(balance && hasMoney),
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

function orderedWindows(provider, windows) {
  if (provider !== "CLAUDE" && provider !== "KIMI") return tightestFirst(windows);
  return [...windows].sort((left, right) =>
    (meterRank(left.key, provider) ?? 90) - (meterRank(right.key, provider) ?? 90) ||
    left.key.localeCompare(right.key));
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
     and stale rows it holds (a quiet source for seven days, a Claude status
     line row until its window resets). */
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
    return { code, name: providerName(code), windows: orderedWindows(code, windows), age: stale.length ? updatedLabel(stale[0], now) : null };
  });
  const headline = (provider) => Math.max(-1, ...provider.windows.map((window) => window.usedPercent ?? -1));
  return model.sort((left, right) => headline(right) - headline(left) || left.name.localeCompare(right.name));
}

function node(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/* Constant artwork: the three dots a row's small menu opens from. */
const MORE_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="3.5" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.5" cy="8" r="1.25"/></svg>';

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

function resetText(window, compact) {
  return window.neutral ? window.limit ?? ""
    : window.limit !== null ? say("moneyOf", { amount: window.limit })
    : window.unbounded ? say("creditsSpent")
    : window.reset === null ? ""
    : window.reset === "" ? say(compact ? "now" : "resettingNow")
    : compact ? window.reset : say("resetsInValue", { time: window.reset });
}

function limitRow(doc, window, compact) {
  const row = node(doc, "div", "q-row");
  row.dataset.band = window.band;
  row.dataset.detail = window.moneyDetail ? "money" : "plain";
  if (window.usedPercent === null) row.dataset.bar = "none";
  const value = node(doc, "span", "q-val");
  if (["yellow", "orange", "red"].includes(window.band)) value.append(art(doc, "q-shape", bandIconSvg(window.band)));
  value.append(node(doc, "span", "", compact || window.unbounded || window.neutral
    ? window.value
    : say("usedValue", { value: window.value })));
  const reset = resetText(window, compact);
  const children = [node(doc, "span", "q-lbl", window.label)];
  if (window.usedPercent !== null) {
    const bar = node(doc, "span", "q-bar");
    bar.setAttribute("role", window.neutral ? "status" : "progressbar");
    bar.setAttribute("aria-label", window.label);
    if (!window.neutral) bar.setAttribute("aria-valuemin", "0");
    if (!window.neutral) bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(Math.floor(window.usedPercent)));
    bar.setAttribute("aria-valuetext", window.neutral
      ? [window.value, window.limit].filter(Boolean).join(", ")
      : window.unbounded ? `${window.value} ${say("creditsSpent")}` : say("usedValue", { value: window.value }));
    const fill = node(doc, "i");
    fill.style?.setProperty("width", `${window.usedPercent}%`);
    bar.append(fill);
    children.push(bar);
  }
  children.push(value, node(doc, "span", "q-rst", reset));
  row.append(...children);
  return row;
}

export function limitsKey(model) {
  return JSON.stringify(model, (key, value) => {
    if (key === "age" || key === "reset") {
      return typeof value === "string" ? "string" : value;
    }
    return value;
  });
}

export function patchLimits(mount, model, { compact = false } = {}) {
  const groups = mount.querySelectorAll(".q-group");
  for (let i = 0; i < model.length; i++) {
    const provider = model[i];
    const group = groups[i];
    if (!group) continue;
    const age = group.querySelector(".q-age");
    if (age) age.textContent = provider.age ?? "";
    const rows = group.querySelectorAll(".q-row");
    for (let j = 0; j < provider.windows.length; j++) {
      const window = provider.windows[j];
      const row = rows[j];
      if (!row) continue;
      const rst = row.querySelector(".q-rst");
      if (rst) rst.textContent = resetText(window, compact);
    }
  }
}

/* The panel's column headings, over the percentage and the countdown. The bars
   already speak their values, so these are for the eye only. */
function columnHeads(doc) {
  const head = node(doc, "div", "q-colhead");
  head.setAttribute("aria-hidden", "true");
  head.append(node(doc, "span"), node(doc, "span"), node(doc, "span", "", say("used")), node(doc, "span", "", say("resetsIn")));
  return head;
}

/* A row's one step: a button that calls its handler with the tool, and a
   short line beside it when that did not work. */
function stepButton(doc, provider, handlers) {
  const wrap = node(doc, "span", "q-tact");
  const status = node(doc, "span", "q-fstatus");
  status.setAttribute("role", "status");
  const { kind, label, title } = provider.action;
  const button = node(doc, "button", kind === "connect" ? "q-btn q-btn-primary" : "q-btn q-btn-ghost", label);
  button.type = "button";
  button.dataset.action = kind;
  if (title) button.setAttribute("title", title);
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    status.textContent = "";
    try {
      const result = await handlers?.[kind]?.(provider.code);
      if (typeof result === "string") status.textContent = result;
      else if (result === false) status.textContent = say("fixFailed");
    } catch {
      status.textContent = say("fixFailed");
    } finally {
      button.disabled = false;
      button.setAttribute("aria-busy", "false");
    }
  });
  wrap.append(status, button);
  return wrap;
}

/* The small menu at the end of a row. Its owner fills it each time it opens,
   so it shows the switch and the fixes as they are now; `opened` keeps it
   open across a redraw. */
function moreMenu(doc, provider, more, opened) {
  const toggle = node(doc, "button", "q-more");
  toggle.type = "button";
  toggle.innerHTML = MORE_ICON;
  toggle.setAttribute("aria-label", say("moreFor", { name: provider.name }));
  const panel = node(doc, "div", "q-morepanel");
  const show = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    panel.replaceChildren();
    if (open) more(provider, panel);
    if (open) opened?.add(provider.code);
    else opened?.delete(provider.code);
  };
  toggle.addEventListener("click", () => show(panel.hidden));
  show(opened?.has(provider.code) === true);
  return { toggle, panel };
}

/**
 * Draw a model: limitsModel rows, or inventoryModel rows on Home. `compact`
 * is the panel's column form. A row with no reading carries a muted note or
 * one step, a button that calls `handlers[kind](code)`; `more` adds the
 * small menu at the end of every row.
 */
export function renderLimits(doc, mount, model, { compact = false, handlers = null, more = null, opened = null } = {}) {
  mount.replaceChildren(...(compact && model.length ? [columnHeads(doc)] : []), ...model.map((provider) => {
    const group = node(doc, "div", "q-group");
    group.dataset.providerCard = "";
    group.dataset.provider = provider.code;
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", provider.name);
    const head = node(doc, "div", "q-prov");
    head.append(markNode(doc, provider.code), node(doc, "span", "q-pname", provider.name));
    if (provider.age) head.append(node(doc, "span", "q-age", provider.age));
    if (provider.note) head.append(node(doc, "span", "q-tnote", provider.note));
    if (provider.action) head.append(stepButton(doc, provider, handlers));
    group.append(head);
    if (more) {
      const menu = moreMenu(doc, provider, more, opened);
      head.append(menu.toggle);
      group.append(menu.panel);
    }
    group.append(...provider.windows.map((window) => limitRow(doc, window, compact)));
    return group;
  }));
}

/** Split the measured bars from the full connection inventory used by Tools. */
export function splitInventory(model = []) {
  const usage = [];
  const tools = [];
  for (const tool of model) {
    if (tool.windows.length > 0) {
      usage.push({ ...tool, action: null, note: null, extra: [] });
      tools.push({ ...tool, windows: [], note: tool.note ?? say("connected") });
    } else {
      tools.push(tool);
    }
  }
  return { usage, tools };
}

/* ------------------------------------------------------------ the inventory */

/* The tools that always have a row, set up or not: the three 2.0.2 hid. */
export const ALWAYS_LISTED = Object.freeze(["CLAUDE", "ANTIGRAVITY", "OPENROUTER"]);

/* Tools this window can set up itself: a guided setup, an import or a key. */
const CONNECTABLE = new Set(["CLAUDE", "CODEX", "ANTIGRAVITY", "OPENCODE", "OPENROUTER"]);

/* Connection states a stored credential cannot read through. */
const REFUSED = new Set(["NEEDS_AUTH", "AUTH_EXPIRED", "ERROR"]);

/* Fixes worth offering for another account of a tool that already reads. */
const ACCOUNT_FIXES = new Set(["sign_in", "reconnect", "open_app"]);

const step = (kind, key, title = null) => ({ action: { kind, label: say(key), title } });

/**
 * The one step a tool with no reading needs, from what is known about it:
 * its flags, its connection records, its detection and, for Claude Code, its
 * setup. "connect" opens this window's own setup or key field for the tool;
 * "check" looks again after the person did the step in the tool itself.
 */
function nextStep(code, name, { flag, flags, records, detection, claude, claudePoll }) {
  const title = (key) => say(key, { name });
  const reasons = new Set(flags.map((entry) => entry.reason));
  /* Waiting with the direct check still off: one click turns it on and reads. */
  const waiting = code === "CLAUDE" && claudePoll === false
    ? {}
    : { note: say("fixWaitingIssue", { name }) };
  if (reasons.has("awaiting_statusline")) return waiting;
  /* A CLI that is not installed blocks every other step, a connect or a sign
     in included, so it is named first; native code marks it per account. */
  if (detection?.accounts?.some((account) => account.recovery === "install_cli")) {
    return { ...step("check", "fixOpenAppAction"), note: say("cliNotFound", { name }) };
  }
  const signInAgain = step("check", "fixSignInAgainIssue", title("fixToolDetail"));
  /* Its action only looks again, so it says so. */
  if (reasons.has("account_unresolved")) return step("check", "fixOpenAppAction", title("fixToolDetail"));
  const refused = records.some((record) => REFUSED.has(record.state));
  const loggedOut = detection?.state === "installed_logged_out";
  if (code === "CLAUDE") {
    if (loggedOut) return signInAgain;
    if (claude === "READY_TO_ENABLE" || claude === "CONNECTED") return waiting;
    return step("connect", "connect");
  }
  if (code === "OPENROUTER") return records.length === 0 || refused ? step("connect", "connect") : step("check", "fixOpenAppAction");
  if (code === "ANTIGRAVITY") {
    if (detection?.statusline_state === "legacy") {
      return { ...step("connect", "setupAntigravityStatusLine"), note: say("antigravityStatusLineLegacy") };
    }
    if (detection?.statusline_state === "disabled") {
      return { ...step("check", "fixOpenAppAction"), note: say("antigravityStatusLineDisabled") };
    }
    return detection?.statusline_configured === true
      ? { note: say("antigravityStatusLineIdle") }
      : step("connect", "setupAntigravityStatusLine");
  }
  if (code === "GEMINI_CLI" && flag?.reason === "quota_unavailable") return { note: say("geminiCliConsumerRetired") };
  if (flag?.fixKind === "unsupported") return { note: say("fixUnsupportedIssue") };
  if (CONNECTABLE.has(code) && (refused || flag?.fixKind === "reconnect" || flag?.fixKind === "sign_in")) return step("connect", "connect");
  if (loggedOut || flag?.fixKind === "sign_in") return signInAgain;
  return step("check", "fixOpenAppAction", title(flag?.fixKind === "open_app" ? "fixOpenAppDetail" : "fixToolDetail"));
}

/**
 * Home's one list: every tool in play, built from the inventory rather than
 * from what happens to be measured. A tool is in play when it always has a
 * row, is detected or connected, is flagged, or a person chose it; one that
 * was switched off leaves unless it always has a row. Measured tools come
 * first, tightest first, with their bars; every other tool follows with a
 * note or one step. `claude` is the Claude Code setup state Connections reads, `claudePoll` the
 * direct Claude check setting (false offers its one click, null is unknown).
 */
export function inventoryModel({ snapshots = [], flags = [], detections = null, connections = [], configured = [], removed = [], claude = null, claudePoll = null } = {}, now) {
  const measured = limitsModel(snapshots, now);
  const shown = new Set(measured.map((tool) => tool.code));
  const off = switchedOff(flags, removed);
  const detected = (detections?.providers ?? []).filter((entry) => entry.state === "present" || entry.state === "installed_logged_out");
  const inPlay = new Set([
    ...ALWAYS_LISTED,
    ...detected.map((entry) => providerCode(entry.provider_id)),
    ...connections.map((entry) => providerCode(entry.provider)),
    ...flags.filter((flag) => flag.fixKind !== "switch_on").map((flag) => flag.provider),
    ...configured.map(providerCode),
  ]);
  const best = new Map(attentionFlags(flags, snapshots, removed).map((flag) => [flag.provider, flag]));
  const rank = (code) => (ALWAYS_LISTED.includes(code) ? ALWAYS_LISTED.indexOf(code) : ALWAYS_LISTED.length);
  const waiting = [...inPlay]
    .filter((code) => code && !shown.has(code) && (ALWAYS_LISTED.includes(code) || !off.has(code)))
    .sort((left, right) => rank(left) - rank(right) || providerName(left).localeCompare(providerName(right)));
  return [
    ...measured.map((tool) => {
      const detection = detected.find((entry) => providerCode(entry.provider_id) === tool.code);
      const antigravity = tool.code === "ANTIGRAVITY"
        ? nextStep(tool.code, tool.name, { flag: best.get(tool.code), flags: [], records: [], detection, claude, claudePoll })
        : null;
      return {
        ...tool,
        action: antigravity?.action ?? null,
        note: antigravity?.note ?? null,
        extra: flags.filter((flag) => flag.provider === tool.code && ACCOUNT_FIXES.has(flag.fixKind)),
      };
    }),
    ...waiting.map((code) => {
      const name = providerName(code);
      const next = off.has(code) ? { note: say("toolOff") } : nextStep(code, name, {
        flag: best.get(code),
        flags: flags.filter((flag) => flag.provider === code),
        records: connections.filter((entry) => providerCode(entry.provider) === code),
        detection: detected.find((entry) => providerCode(entry.provider_id) === code),
        claude,
        claudePoll,
      });
      return { code, name, windows: [], age: null, action: next.action ?? null, note: next.note ?? null, extra: [] };
    }),
  ];
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
