/**
 * The free account cap, and the four ways an account can be paused.
 *
 * Contract section 3 is the whole of this file's brief, and two sentences in
 * it decide almost every pixel below.
 *
 *   "The Free cap is one active account per provider and is enforced only by
 *   desktop business logic."
 *
 * So this screen never deletes anything and never asks Rust to. It presents a
 * choice and sends one reconciliation, and Rust derives the entitlement it
 * trusts rather than believing what this window claims about the plan.
 *
 *   "The UI must distinguish paused_by_plan, paused_by_user,
 *   credential_invalid and provider_unavailable."
 *
 * So a paused row says which of the four it is, in a sentence rather than in a
 * code, because "paused" alone leaves a person guessing whether they did it,
 * whether they are being charged, or whether something is broken. Only one of
 * the four is anything they need to act on.
 *
 * The grandfathered exception gets a badge of its own. A person who had three
 * Claude accounts before the cap existed keeps them, and the badge is the
 * product saying so out loud rather than leaving them waiting for the day it
 * silently changes its mind.
 *
 * A keeper swap is one atomic plan, never a pause followed by a resume. Two
 * calls have a moment between them where either nothing is active or two are,
 * and the moment a poll lands in that gap is the moment the cap looks broken.
 */
import { providerMarkMarkup } from "./engine/ui/provider-row.js";
import {
  BACKEND_ABSENT,
  listConnections,
  normalizeConnectionList,
  proStatus,
  reconcileConnectionPlan,
  setConnectionPaused,
} from "./backend.js";

/*
 * backend.js hands every connection over with `provider` already uppercased
 * from the wire's provider id, so these three tables are keyed on that exact
 * string and nothing here re-derives it.
 */
const PROVIDER_CODE = {
  "ANTHROPIC/CLAUDE-CODE": "CLAUDE",
  "OPENAI/CODEX": "CODEX",
  "GOOGLE/GEMINI-CLI": "GEMINI_CLI",
  "GOOGLE/ANTIGRAVITY": "ANTIGRAVITY",
  "OPENCODE/OPENCODE": "OPENCODE",
  "OPENROUTER/API": "OPENROUTER",
  "XAI/API": "GROK",
  "MOONSHOT/API": "KIMI",
  "OPENLIMITER/MANUAL": "MANUAL",
};

const PROVIDER_LABEL = {
  "ANTHROPIC/CLAUDE-CODE": "Claude Code",
  "OPENAI/CODEX": "Codex",
  "GOOGLE/GEMINI-CLI": "Gemini CLI",
  "GOOGLE/ANTIGRAVITY": "Antigravity",
  "OPENCODE/OPENCODE": "OpenCode",
  "OPENROUTER/API": "OpenRouter",
  "XAI/API": "Grok",
  "MOONSHOT/API": "Kimi",
  "OPENLIMITER/MANUAL": "Manual",
};

const PROVIDER_ACCENT = {
  "ANTHROPIC/CLAUDE-CODE": "var(--ol-provider-claude)",
  "MOONSHOT/API": "var(--ol-provider-kimi)",
  "GOOGLE/ANTIGRAVITY": "var(--ol-provider-google-red)",
  "GOOGLE/GEMINI-CLI": "var(--ol-provider-gemini-blue)",
};

/* A provider id becomes a stable element id, so the harness and a keyboard
   walk can both reach the control that opens a given provider's dialogue. */
function providerSlug(provider) {
  return String(provider).toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}

/**
 * The four pause reasons, said as a person would say them.
 *
 * `action` is what they can do about it, and it is null for the two they
 * cannot: a plan pause is undone by the plan or by choosing this account as
 * the keeper, and a provider outage is undone by the provider.
 */
export const PAUSE_REASONS = {
  paused_by_plan: {
    badge: "Paused by plan",
    tone: "watch",
    sentence:
      "Your plan allows one active account for this provider, so this one is held. Nothing was deleted and nothing was changed inside it.",
    action: "Make this the active account",
  },
  paused_by_user: {
    badge: "Paused by you",
    tone: null,
    sentence: "You paused this account. It keeps its credential, its history and its label.",
    action: "Resume",
  },
  credential_invalid: {
    badge: "Sign in again",
    tone: "critical",
    sentence:
      "The stored credential stopped working, so this account was paused rather than polled with something the provider rejects.",
    action: "Reconnect",
  },
  provider_unavailable: {
    badge: "Provider unavailable",
    tone: "high",
    sentence:
      "The provider is not answering for this account. OpenLimiter will keep trying and resume on its own.",
    action: null,
  },
};

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function providerCode(id) {
  return PROVIDER_CODE[id] ?? "MANUAL";
}

function providerLabel(id) {
  return PROVIDER_LABEL[id] ?? id;
}

/** Group connections by provider, oldest first, which is the tie breaker. */
export function groupByProvider(connections) {
  const groups = new Map();
  for (const row of connections) {
    const key = row.provider;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    rows.sort((left, right) => {
      const byCreated = instantValue(left.createdAt) - instantValue(right.createdAt);
      if (byCreated !== 0) return byCreated;
      return String(left.id).localeCompare(String(right.id));
    });
  }
  return groups;
}

/**
 * How many ordinary accounts this provider may keep active.
 *
 * Contract 3.1: `max(1, active_surviving_legacy_count)`, and when any legacy
 * record is active no ordinary record may be active beside it. The arithmetic
 * lives here rather than in the markup so the sentence a person reads and the
 * rule a button obeys are the same expression.
 */
export function capFor(rows, multiAccount) {
  if (multiAccount) return { allowed: Infinity, legacyActive: 0, ordinaryAllowed: Infinity };
  const legacyActive = rows.filter(
    (row) => row.legacyGrandfathered === true && row.active === true
  ).length;
  return {
    allowed: Math.max(1, legacyActive),
    legacyActive,
    ordinaryAllowed: legacyActive > 0 ? 0 : 1,
  };
}

/** The deterministic keeper when a person does not choose one: 3.3. */
export function defaultKeeper(rows) {
  const ordinary = rows.filter((row) => row.legacyGrandfathered !== true);
  if (ordinary.length === 0) return null;
  const sorted = [...ordinary].sort((left, right) => {
    const byCreated = instantValue(left.createdAt) - instantValue(right.createdAt);
    if (byCreated !== 0) return byCreated;
    return String(left.id).localeCompare(String(right.id));
  });
  return sorted[0] ?? null;
}

/* backend.js normalises every instant to an ISO string, so both spellings are
   accepted and anything unreadable says so rather than printing an epoch. */
function whenText(value) {
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at)) return "never";
  return new Date(at).toLocaleString();
}

function instantValue(value) {
  const at = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(at) ? at : 0;
}

function accountRowMarkup(row, context) {
  const provider = row.provider;
  const paused = row.active !== true;
  const reason = paused ? PAUSE_REASONS[row.pauseReason] ?? null : null;
  const badges = [];

  if (row.legacyGrandfathered === true) {
    badges.push(
      '<span class="badge" data-tone="accent" title="Kept from before the one account cap">Grandfathered</span>'
    );
  }
  if (reason !== null) {
    badges.push(
      '<span class="badge"' +
        (reason.tone === null ? "" : ' data-tone="' + reason.tone + '"') +
        ">" +
        escapeText(reason.badge) +
        "</span>"
    );
  } else if (!paused) {
    badges.push('<span class="badge" data-tone="ok">Active</span>');
  }

  const detail =
    reason === null
      ? "Last read " + whenText(row.lastSuccessAt)
      : reason.sentence;

  const actions = [];
  if (paused && context.canResume(row)) {
    actions.push(
      '<button type="button" class="small" data-cap-action="keeper" data-connection="' +
        escapeText(row.id) +
        '" data-provider="' +
        escapeText(provider) +
        '">' +
        escapeText(reason?.action ?? "Resume") +
        "</button>"
    );
  } else if (!paused && context.canPause) {
    actions.push(
      '<button type="button" class="small" data-cap-action="pause" data-connection="' +
        escapeText(row.id) +
        '">Pause</button>'
    );
  }

  return (
    '<article class="account-row" data-active="' +
    String(!paused) +
    '" data-paused="' +
    String(paused) +
    '" style="--provider-accent:' +
    (PROVIDER_ACCENT[provider] ?? "var(--accent)") +
    '">' +
    '<span class="account-mark" aria-hidden="true">' +
    providerMarkMarkup(providerCode(provider)) +
    "</span>" +
    '<span class="account-body"><span class="account-name">' +
    '<span class="account-alias">' +
    escapeText(row.accountAlias ?? "default") +
    "</span>" +
    badges.join("") +
    "</span>" +
    '<span class="account-detail">' +
    escapeText(detail) +
    "</span></span>" +
    '<span class="account-actions">' +
    actions.join("") +
    "</span></article>"
  );
}

function groupMarkup(provider, rows, multiAccount) {
  const cap = capFor(rows, multiAccount);
  const activeOrdinary = rows.filter(
    (row) => row.active === true && row.legacyGrandfathered !== true
  ).length;
  const context = {
    canPause: true,
    /* An ordinary account can be resumed only where the cap has room, and a
       grandfathered one only where no ordinary account holds the slot. */
    canResume: (row) => {
      if (multiAccount) return true;
      if (row.pauseReason === "provider_unavailable") return false;
      if (row.legacyGrandfathered === true) return activeOrdinary === 0;
      return true;
    },
  };

  const capSentence = multiAccount
    ? "Pro: as many accounts as you connect."
    : cap.legacyActive > 0
    ? "Free: " +
      String(cap.legacyActive) +
      " grandfathered " +
      (cap.legacyActive === 1 ? "account is" : "accounts are") +
      " active, so no ordinary account can be active beside them."
    : "Free: one active account for this provider.";

  return (
    '<section class="provider-group" data-provider="' +
    escapeText(provider) +
    '">' +
    '<h3 class="provider-group-head"><span>' +
    escapeText(providerLabel(provider)) +
    "</span><span>" +
    String(rows.filter((row) => row.active === true).length) +
    " of " +
    String(rows.length) +
    " active</span></h3>" +
    rows.map((row) => accountRowMarkup(row, context)).join("") +
    '<p class="cap-line"><span>' +
    escapeText(capSentence) +
    "</span>" +
    (multiAccount || rows.length < 2
      ? ""
      : '<button type="button" class="small" id="cap-choose-' +
        escapeText(provider) +
        '" data-cap-action="choose" data-provider="' +
        escapeText(provider) +
        '">Choose the active account</button>') +
    "</p></section>"
  );
}

/* ------------------------------------------------------ keeper selection */

/**
 * The keeper dialogue.
 *
 * Contract 3.3 says desktop asks before a known downgrade and falls back to
 * the oldest account when a person does not choose. The dialogue therefore
 * opens with that fallback already selected: closing it without touching
 * anything produces exactly the outcome the contract describes, so a person
 * who does not want to decide is not punished for it.
 */
function keeperSheetMarkup(provider, rows) {
  const fallback = defaultKeeper(rows);
  const choices = rows
    .filter((row) => row.legacyGrandfathered !== true)
    .map((row) => {
      const checked = fallback !== null && row.id === fallback.id;
      const paused = row.active !== true;
      const reason = paused ? PAUSE_REASONS[row.pauseReason] ?? null : null;
      return (
        '<label class="choice"><input type="radio" name="keeper" value="' +
        escapeText(row.id) +
        '"' +
        (checked ? " checked" : "") +
        ' /><span class="choice-body"><strong>' +
        escapeText(row.accountAlias ?? "default") +
        "</strong><span>" +
        escapeText(
          "Connected " +
            whenText(row.createdAt) +
            (reason === null ? ", active now" : ", " + reason.badge.toLowerCase())
        ) +
        "</span></span></label>"
      );
    })
    .join("");

  const legacy = rows.filter((row) => row.legacyGrandfathered === true);
  const legacyNote =
    legacy.length === 0
      ? ""
      : '<p class="note tight">' +
        escapeText(
          legacy.length === 1
            ? "One grandfathered account keeps whatever state it has today. It is not part of this choice and it is never paused by a plan change."
            : String(legacy.length) +
                " grandfathered accounts keep whatever state they have today. They are not part of this choice and they are never paused by a plan change."
        ) +
        "</p>";

  return (
    '<div class="sheet" id="keeper-sheet" role="dialog" aria-modal="true" ' +
    'aria-labelledby="keeper-title">' +
    '<div class="sheet-panel">' +
    '<h2 id="keeper-title">Choose the active ' +
    escapeText(providerLabel(provider)) +
    " account</h2>" +
    '<p class="note tight">Free keeps one account per provider active. Every other one is paused, which leaves its credential, its history and its label exactly where they are. You can swap at any time.</p>' +
    '<div class="stack" role="radiogroup" aria-labelledby="keeper-title">' +
    choices +
    "</div>" +
    legacyNote +
    '<div class="sheet-actions">' +
    '<button type="button" data-keeper="cancel">Cancel</button>' +
    '<button type="button" class="primary" data-keeper="confirm" data-provider="' +
    escapeText(provider) +
    '">Keep this one active</button>' +
    "</div></div></div>"
  );
}

let lastFocused = null;

function closeKeeperSheet() {
  document.getElementById("keeper-sheet")?.remove();
  if (lastFocused !== null && document.contains(lastFocused)) {
    lastFocused.focus();
  }
  lastFocused = null;
}

/** Keep tab inside the dialogue while it is open. */
function trapFocus(sheet) {
  sheet.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeKeeperSheet();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = sheet.querySelectorAll(
      'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

/* ------------------------------------------------------------- rendering */

const state = {
  connections: [],
  multiAccount: false,
  mount: null,
  onChange: null,
};

export async function renderPlanCap(mount, options = {}) {
  state.mount = mount;
  state.onChange = options.onChange ?? null;
  if (mount === null) return;

  const [connectionsResult, proResult] = await Promise.all([
    listConnections(),
    proStatus(),
  ]);

  if (!connectionsResult.ok && connectionsResult.reason === BACKEND_ABSENT) {
    mount.innerHTML =
      '<p class="note">This build has no connection backend, so there are no accounts to manage.</p>';
    return;
  }

  const connections = connectionsResult.ok
    ? normalizeConnectionList(connectionsResult.value)
    : [];
  const pro = proResult.ok ? proResult.value : null;
  const multiAccount = pro?.multi_account === true;
  state.connections = connections;
  state.multiAccount = multiAccount;

  if (connections.length === 0) {
    mount.innerHTML =
      '<p class="note">No account is connected yet. Connect one below and it becomes the active account for its provider.</p>';
    return;
  }

  const groups = groupByProvider(connections);
  const blocked = [...groups.entries()].filter(
    ([, rows]) => !multiAccount && rows.length > 1
  );

  mount.innerHTML =
    (blocked.length === 0 || multiAccount
      ? ""
      : '<div class="callout" id="cap-unlock"><strong>More than one account per provider is a Pro feature</strong>' +
        "<p>You have " +
        String(blocked.length) +
        (blocked.length === 1 ? " provider" : " providers") +
        " with a second account. On Free one stays active per provider and the rest are held, with nothing deleted. Pro runs them all at once." +
        '</p><div class="button-row">' +
        '<button type="button" class="primary" data-cap-action="unlock">See what Pro adds</button>' +
        "</div></div>") +
    '<div class="stack wide">' +
    [...groups.entries()]
      .map(([provider, rows]) => groupMarkup(provider, rows, multiAccount))
      .join("") +
    "</div>";
}

/* One delegated listener for the whole surface, so a repaint never leaves a
   dead button behind holding a reference to markup that no longer exists. */
document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest("[data-cap-action]");
  if (control === null || control === undefined) return;
  const action = control.getAttribute("data-cap-action");

  if (action === "choose") {
    const provider = control.getAttribute("data-provider");
    const rows = groupByProvider(state.connections).get(provider) ?? [];
    lastFocused = control;
    document.body.insertAdjacentHTML("beforeend", keeperSheetMarkup(provider, rows));
    const sheet = document.getElementById("keeper-sheet");
    trapFocus(sheet);
    sheet.querySelector("input[name='keeper']:checked")?.focus();
    return;
  }

  if (action === "pause") {
    const id = control.getAttribute("data-connection");
    control.disabled = true;
    await setConnectionPaused(id, true);
    await renderPlanCap(state.mount, { onChange: state.onChange });
    state.onChange?.();
    return;
  }

  if (action === "keeper") {
    /* A swap is one plan, not a resume beside a pause. Reconciliation names
       the survivor and Rust derives everything else from the entitlement it
       verified, so there is never a moment with two active or none. */
    const id = control.getAttribute("data-connection");
    control.disabled = true;
    await reconcileConnectionPlan([id]);
    await renderPlanCap(state.mount, { onChange: state.onChange });
    state.onChange?.();
    return;
  }

  if (action === "unlock") {
    document.getElementById("tab-settings")?.click();
    document.getElementById("pro-plan")?.scrollIntoView({ block: "center" });
    return;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest("[data-keeper]");
  if (control === null || control === undefined) return;
  if (control.getAttribute("data-keeper") === "cancel") {
    closeKeeperSheet();
    return;
  }
  const sheet = document.getElementById("keeper-sheet");
  const chosen = sheet?.querySelector("input[name='keeper']:checked");
  const keeper = chosen?.value ?? null;
  closeKeeperSheet();
  if (keeper === null) return;
  await reconcileConnectionPlan([keeper]);
  await renderPlanCap(state.mount, { onChange: state.onChange });
  state.onChange?.();
});
