/**
 * The Connections tab.
 *
 * Everything on it is a claim about this exact build, verified through the
 * backend adapter before it is drawn. A connection card exists only because
 * list_connections returned that record. The Claude card's state comes from
 * detect_local_tools. The OpenRouter form stores a key only through
 * connect_provider. When the backend does not carry those commands, because
 * this build predates them or the window is being served outside the shell,
 * the tab says so in one honest block and draws nothing in their place.
 *
 * What this file decides is layout and wording glue. What it never decides is
 * vocabulary or policy:
 *
 *   the sentence and the next action for every connection state come from
 *   packages/core/src/connection-state.ts, mirrored into this bundle, so a
 *   card here and a block on the web dashboard describe one state with one
 *   sentence;
 *
 *   the durable schedule and collector outcome come from Rust. This module
 *   renders those facts and can ask Rust for one explicit refresh.
 *
 * The whole collection transaction belongs to Rust. Its persisted schedule,
 * provider read, parser, cache fold, completion and backoff continue when this
 * renderer is hidden or reloaded. A collector-updated event asks this module
 * only to reread and render state.
 *
 * The IPC result contains only a closed success or failure. It carries no
 * provider body, credential, cache generation, or writable connection state.
 */
import {
  CONNECTION_STATES,
  connectionNextAction,
  connectionSentence,
  queryCatalogueRows,
} from "./engine/core/index.js";
import { PROVIDER_SPECS } from "./provider-specs.generated.js";
import * as backend from "./backend.js";

/** The event Rust emits after a native collection pass changes observable state. */
const COLLECTOR_UPDATED_EVENT = "collector-updated";

/** The 13 states as a set, to check a record's claim before believing it. */
const KNOWN_STATES = new Set(CONNECTION_STATES);

/**
 * The exact statusline wiring, byte for byte the block the documentation
 * publishes. Copy plus verify is the whole flow: this window never edits
 * anybody's settings file.
 */
const CLAUDE_SETUP_SNIPPET = `{
  "statusLine": {
    "type": "command",
    "command": "openlimiter statusline"
  }
}`;

/**
 * Everything this module knows about the world, in one place.
 *
 * `backendPresent` is three valued: null before the first probe answers, then
 * true or false. The render function treats null as "say nothing yet" so the
 * absent block never flashes on a build that does have the backend.
 */
const session = {
  ready: false,
  backendPresent: null,
  listError: null,
  connections: [],
  /** Providers whose refresh_provider came back CONNECTED in this run. */
  liveRefreshOk: new Set(),
  /**
   * Per connection id: the last action's feedback line, { text, tone }.
   * Kept here rather than only in the DOM because every render rebuilds the
   * cards, and a sentence that vanishes the instant the state redraws was
   * never read by anyone.
   */
  cardNotes: {},
  /** Native heartbeat state, retained by Rust across renderer reloads. */
  collectorStatus: null,
  /** The last detect_local_tools answer for Claude Code, normalized. */
  claude: null,
  claudeProbed: false,
  /** Preflight verdict object for Claude Code connection flow. */
  claudeVerdict: null,
  claudeConsentOpen: false,
};

/** Wired by initConnections. Nothing here runs before that. */
let options = null;

let el = null;

function grabElements() {
  el = {
    panel: document.getElementById("panel-connections"),
    schedulerLine: document.getElementById("scheduler-line"),
    absent: document.getElementById("connections-absent"),
    reprobe: document.getElementById("connections-reprobe"),
    empty: document.getElementById("connections-empty"),
    cards: document.getElementById("connections-cards"),
    openrouterAdd: document.getElementById("openrouter-add"),
    openrouterKind: () =>
      document.querySelector('input[name="openrouter-kind"]:checked'),
    openrouterKey: document.getElementById("openrouter-key"),
    openrouterAlias: document.getElementById("openrouter-alias"),
    openrouterSubmit: document.getElementById("openrouter-submit"),
    openrouterNote: document.getElementById("openrouter-note"),
    claudeCard: document.getElementById("claude-card"),
    claudeState: document.getElementById("claude-state"),
    claudeStateCode: document.getElementById("claude-state-code"),
    claudeSentence: document.getElementById("claude-sentence"),
    claudeDetail: document.getElementById("claude-detail"),
    claudeSnippet: document.getElementById("claude-snippet"),
    claudeCopy: document.getElementById("claude-copy"),
    claudeVerify: document.getElementById("claude-verify"),
    claudeNote: document.getElementById("claude-note"),
    claudeBody: document.getElementById("claude-body"),
    catalogueRows: document.getElementById("catalogue-rows"),
  };
}

/* ----------------------------------------------------------------- language */

/**
 * A state code as the short word a chip can hold.
 *
 * The code itself, in sentence case: STALE is "Stale", AUTH_EXPIRED is "Auth
 * expired". The full sentence from the core rides in the title. Nothing is
 * reworded, because the vocabulary is the core's and this file only changes
 * its case.
 */
export function stateWord(code) {
  const text = String(code).toLowerCase().replace(/_/gu, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The core sentence for a state, or an honest refusal for a code outside it. */
function sentenceFor(state) {
  return KNOWN_STATES.has(state)
    ? connectionSentence[state]
    : "This build does not know this state code, so it claims nothing about it.";
}

function timeWord(iso) {
  if (iso === null || iso === undefined) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleString();
}

/* ----------------------------------------------------------------- backend */

async function syncConnections() {
  const result = await backend.listConnections();
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) {
      session.backendPresent = false;
      session.connections = [];
    } else {
      session.backendPresent = true;
      session.listError = result.message;
    }
    return;
  }
  session.backendPresent = true;
  session.listError = null;
  session.connections = backend.normalizeConnectionList(result.value);
}

async function syncCollectorStatus() {
  const result = await backend.collectorStatus();
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) session.backendPresent = false;
    return;
  }
  session.backendPresent = true;
  session.collectorStatus = backend.normalizeCollectorStatus(result.value);
}

/**
 * One refresh for one connection: probe, parse, commit to the cache through
 * the handshake, and close the attempt. Success means validated snapshots
 * reached the cache in this run, which is the one fact that lets a meters row
 * say Connected.
 */
async function runRefresh(record) {
  const result = await backend.refreshProvider({ connectionId: record.id });
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) {
      session.backendPresent = false;
      return { succeeded: false, note: "This build has no connection backend yet." };
    }
    return { succeeded: false, note: result.message };
  }
  const outcome = backend.normalizeCollectionOutcome(result.value);
  const committed = outcome.kind === "cache_committed";
  const note = outcome.succeeded ? null : outcome.message;
  await syncCollectorStatus();
  await syncConnections();
  if (committed && record.provider !== null) {
    session.liveRefreshOk.add(record.provider);
  }
  return { succeeded: committed, note };
}

async function runTest(record) {
  const result = await backend.testProvider({ connectionId: record.id });
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) {
      session.backendPresent = false;
      return { succeeded: false, absent: true, note: "This build has no connection backend yet." };
    }
    return { succeeded: false, absent: false, note: result.message };
  }
  const outcome = backend.normalizeCollectionOutcome(result.value);
  await syncCollectorStatus();
  await syncConnections();
  return {
    succeeded: outcome.kind === "tested",
    absent: false,
    note: outcome.succeeded ? null : outcome.message,
  };
}

/** The manual refresh action shared by a connection card and its catalogue row. */
async function refreshNow(record) {
  const outcome = await runRefresh(record);
  if (outcome.succeeded) options.onMetersChanged();
  return outcome;
}

/* ---------------------------------------------------------- claude detection */

/** The first defined value under any of several key spellings. */
function pick(record, names) {
  for (const name of names) {
    const value = record?.[name];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/**
 * The detect_local_tools answer, reduced to the three facts the card needs:
 * was Claude Code found, is the statusline pointed at OpenLimiter, and did
 * the backend hand over a state of its own. Every spelling a serializer
 * plausibly produces is accepted; anything unreadable is null, and null is
 * rendered as not knowing rather than as either answer.
 */
function normalizeDetection(value) {
  let entry = null;
  if (Array.isArray(value)) {
    entry = value.find((item) => {
      const name = pick(item, ["id", "tool", "name", "toolId", "tool_id"]);
      return typeof name === "string" && /claude/iu.test(name);
    }) ?? null;
  } else if (value !== null && typeof value === "object") {
    entry = pick(value, ["claudeCode", "claude_code", "claude", "CLAUDE"]) ?? value;
  }
  if (entry === null || typeof entry !== "object") return null;
  /* The backend's own spelling comes first. It reports the presence of the
     Claude Code settings file, which is the only evidence of the tool this
     detection gathers, and leaving it out of this list is why the card used to
     say the answer could not be read on a machine where Claude Code was
     plainly installed. The other spellings stay as a tolerance. */
  const found = pick(entry, [
    "claude_settings_present",
    "claudeSettingsPresent",
    "installed",
    "present",
    "found",
    "detected",
  ]);
  const wired = pick(entry, [
    "statuslineWired",
    "statusline_wired",
    "statuslineConfigured",
    "statusline_configured",
    "wired",
    "configured",
  ]);
  const state = pick(entry, ["state", "status"]);
  return {
    found: typeof found === "boolean" ? found : null,
    wired: typeof wired === "boolean" ? wired : null,
    state: typeof state === "string" && KNOWN_STATES.has(state) ? state : null,
  };
}

/**
 * Normalizes the preflight verdict object, reading snake_case fields defensively.
 * An unreadable verdict returns null, never a guess.
 */
function normalizePreflight(value) {
  if (value === null || typeof value !== "object") return null;
  const kind = pick(value, ["kind"]);
  const validKinds = new Set([
    "ready",
    "wrappable_status_line",
    "cli_missing",
    "cli_not_working",
    "settings_unknown",
    "guided_manual",
  ]);
  if (typeof kind !== "string" || !validKinds.has(kind)) return null;

  const cliFound = pick(value, ["cli_found", "cliFound"]);
  const cliWorking = pick(value, ["cli_working", "cliWorking"]);
  const settingsPresent = pick(value, ["settings_present", "settingsPresent"]);
  const settingsShapeKnown = pick(value, ["settings_shape_known", "settingsShapeKnown"]);
  const foreignStatusLine = pick(value, ["foreign_status_line", "foreignStatusLine"]);
  const foreignUserPromptSubmitHooks = pick(
    value,
    ["foreign_user_prompt_submit_hooks", "foreignUserPromptSubmitHooks"],
  );
  const cliPath = pick(value, ["cli_path", "cliPath"]);
  const installCommand = pick(value, ["install_command", "installCommand"]);

  return {
    kind,
    cliFound: typeof cliFound === "boolean" ? cliFound : false,
    cliWorking: typeof cliWorking === "boolean" ? cliWorking : false,
    settingsPresent: typeof settingsPresent === "boolean" ? settingsPresent : false,
    settingsShapeKnown: typeof settingsShapeKnown === "boolean" ? settingsShapeKnown : false,
    foreignStatusLine: typeof foreignStatusLine === "boolean" ? foreignStatusLine : false,
    foreignUserPromptSubmitHooks:
      typeof foreignUserPromptSubmitHooks === "boolean"
        ? foreignUserPromptSubmitHooks
        : false,
    cliPath: typeof cliPath === "string" ? cliPath : null,
    installCommand:
      typeof installCommand === "string"
        ? installCommand
        : "npm install -g openlimiter",
  };
}

/** Check the real CLI and Claude Code settings without changing either. */
async function runClaudePreflight() {
  const result = await backend.claudeConnectPreflight();
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) session.backendPresent = false;
    session.claudeVerdict = null;
    return;
  }
  session.backendPresent = true;
  session.claudeVerdict = normalizePreflight(result.value);
}

async function detectClaude() {
  const result = await backend.detectLocalTools();
  session.claudeProbed = true;
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) session.backendPresent = false;
    session.claude = null;
    return;
  }
  session.backendPresent = true;
  session.claude = normalizeDetection(result.value);
}

/**
 * The Claude card's state, in the core's own vocabulary.
 *
 * The backend's own state wins when it sent one. Otherwise: not found is
 * NOT_CONFIGURED, found but not wired is DETECTED, and wired splits on
 * whether a fresh statusline reading is actually in the cache right now,
 * which is the difference between ready to collect and collecting. Null
 * means detection itself was impossible, and the card says that instead.
 */
function claudeStateOf() {
  const detection = session.claude;
  if (detection === null) return null;
  if (detection.state !== null) return detection.state;
  if (detection.found === null) return null;
  if (detection.found === false) return "NOT_CONFIGURED";
  if (detection.wired !== true) return "DETECTED";
  return options.hasFreshLocalClaude() ? "CONNECTED" : "READY_TO_ENABLE";
}

/* ---------------------------------------------------------------- dom kit */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setNote(node, text, tone) {
  node.textContent = text;
  node.dataset.tone = tone ?? "plain";
}

/** A card's feedback line: shown now, and kept across the next renders. */
function keepCardNote(id, node, text, tone) {
  session.cardNotes[id] = { text, tone: tone ?? "plain" };
  setNote(node, text, tone);
}

/** The state chip a card leads with: a dot, then the code, in mono. */
function stateChip(state) {
  const known = KNOWN_STATES.has(state);
  const chip = element("span", "chip muted conn-state");
  chip.dataset.connectionState = known ? state : "UNRECOGNISED";
  chip.title = sentenceFor(state);
  const dot = element("span", "state-dot");
  dot.setAttribute("aria-hidden", "true");
  chip.append(dot);
  chip.append(element("span", "mono tracked", String(state)));
  return chip;
}

function fact(label, value) {
  const wrap = element("div", "conn-fact");
  wrap.append(element("dt", "fact-label", label));
  wrap.append(element("dd", "fact-value", value));
  return wrap;
}

/* ------------------------------------------------------------------ cards */

const STATE_CONSTRAINT_RANK = {
  ERROR: 100,
  AUTH_EXPIRED: 90,
  NEEDS_AUTH: 80,
  DEGRADED: 70,
  STALE: 60,
  UNSUPPORTED: 50,
  IMPORT_ONLY: 45,
  MANUAL: 40,
  CONNECTING: 35,
  READY_TO_ENABLE: 30,
  DETECTED: 20,
  NOT_CONFIGURED: 10,
  CONNECTED: 0,
};

export function mostConstrainedState(states) {
  if (!states || states.length === 0) return "NOT_CONNECTED";
  let worst = states[0];
  let worstRank = STATE_CONSTRAINT_RANK[worst] ?? 0;
  for (let i = 1; i < states.length; i++) {
    const s = states[i];
    const rank = STATE_CONSTRAINT_RANK[s] ?? 0;
    if (rank > worstRank) {
      worst = s;
      worstRank = rank;
    }
  }
  return worst;
}

function renderAccountRow(record, now) {
  const row = element("div", "conn-account-row");

  const head = element("div", "conn-account-head");
  const accountName =
    (record.accountAlias && String(record.accountAlias).trim()) ||
    (record.maskedLabel && String(record.maskedLabel).trim()) ||
    "Unnamed connection";

  const titleEl = element("span", "account-name", accountName);
  const chip = stateChip(record.state ?? "UNSTATED");
  head.append(titleEl, chip);
  row.append(head);

  const note = element("p", "conn-note");
  note.setAttribute("role", "status");
  const kept = session.cardNotes[record.id];
  if (kept !== undefined) setNote(note, kept.text, kept.tone);

  const actions = element("div", "conn-actions");
  if (KNOWN_STATES.has(record.state)) {
    actions.append(
      element("span", "chip muted next-hint", "Next: " + connectionNextAction[record.state]),
    );
  }

  const testBtn = element("button", undefined, "Test connection");
  testBtn.type = "button";
  const refreshBtn = element("button", undefined, "Refresh now");
  refreshBtn.type = "button";
  const disconnectBtn = element("button", undefined, "Disconnect");
  disconnectBtn.type = "button";
  const controls = [testBtn, refreshBtn, disconnectBtn];
  const busy = (on) => {
    for (const ctrl of controls) ctrl.disabled = on;
  };

  testBtn.addEventListener("click", () => {
    void (async () => {
      busy(true);
      setNote(note, "Asking the provider.", "plain");
      const asked = await runTest(record);
      if (asked.absent) {
        keepCardNote(record.id, note, "This build has no connection backend yet.", "bad");
        render();
        return;
      }
      const settled = session.connections.find((entry) => entry.id === record.id);
      if (asked.note !== null) {
        keepCardNote(record.id, note, "The test failed. " + asked.note, "bad");
      } else {
        keepCardNote(
          record.id,
          note,
          sentenceFor(settled?.state ?? record.state),
          asked.succeeded ? "ok" : "bad",
        );
      }
      render();
    })();
  });

  refreshBtn.addEventListener("click", () => {
    void (async () => {
      busy(true);
      setNote(note, "Refreshing.", "plain");
      const outcome = await refreshNow(record);
      if (outcome.succeeded) {
        keepCardNote(
          record.id,
          note,
          "Refreshed. The reading is in the cache and on the meters.",
          "ok",
        );
      } else if (outcome.note !== null) {
        keepCardNote(record.id, note, outcome.note, "bad");
      } else {
        const fresh = session.connections.find((entry) => entry.id === record.id);
        keepCardNote(record.id, note, sentenceFor(fresh?.state ?? record.state), "bad");
      }
      render();
    })();
  });

  let confirming = null;
  /* Disconnect asks twice. The second press within four seconds is the
     confirmation, and the button says so rather than opening a dialog: a
     misclick here costs somebody a credential they have to go and find again,
     and a browser confirm() would block the whole window. */
  disconnectBtn.addEventListener("click", () => {
    if (confirming === null) {
      disconnectBtn.textContent = "Press again to disconnect";
      disconnectBtn.classList.add("confirming");
      confirming = window.setTimeout(() => {
        confirming = null;
        disconnectBtn.textContent = "Disconnect";
        disconnectBtn.classList.remove("confirming");
      }, 4_000);
      return;
    }
    window.clearTimeout(confirming);
    confirming = null;
    void (async () => {
      busy(true);
      const result = await backend.disconnectProvider(record.id);
      if (result.ok) {
        delete session.cardNotes[record.id];
        if (
          record.provider !== null &&
          !session.connections.some(
            (entry) => entry.provider === record.provider && entry.id !== record.id,
          )
        ) {
          session.liveRefreshOk.delete(record.provider);
        }
      } else {
        keepCardNote(
          record.id,
          note,
          result.reason === backend.BACKEND_ABSENT
            ? "This build has no connection backend yet."
            : "Disconnecting failed: " + result.message,
          "bad",
        );
      }
      await syncConnections();
      options.onMetersChanged();
      render();
    })();
  });

  actions.append(testBtn, refreshBtn, disconnectBtn);
  row.append(actions);
  row.append(note);
  return row;
}

function renderProviderAccounts(providerId, records, now) {
  const container = document.getElementById(providerId + "-accounts");
  if (!container) return;
  container.textContent = "";
  if (!records || records.length === 0) return;
  const list = element("div", "conn-account-list");
  for (const rec of records) {
    list.append(renderAccountRow(rec, now));
  }
  container.append(list);
}

/* ----------------------------------------------------------------- render */

function renderSchedulerLine() {
  if (session.backendPresent === false) {
    el.schedulerLine.textContent =
      "The native collector is unavailable: this build has no connection backend.";
    return;
  }
  const status = session.collectorStatus;
  if (status === null || status.lastPassAt === null) {
    el.schedulerLine.textContent = "The native collector is starting.";
    return;
  }
  const stamp = timeWord(status.lastPassAt);
  const failure = status.lastFailure;
  el.schedulerLine.textContent =
    "Native collector checked " +
    stamp +
    ". Passes this process: " +
    String(status.ticks) +
    "." +
    (failure === null
      ? ""
      : " Last failure: " +
        (backend.COLLECTOR_FAILURE_SENTENCES[failure] ?? failure));
}

function renderClaude() {
  el.claudeSnippet.textContent = CLAUDE_SETUP_SNIPPET;
  if (el.claudeBody) el.claudeBody.textContent = "";

  /* No backend, no look. Saying "looking" while nothing can look would be a
     claim about an activity this build cannot perform. */
  if (session.backendPresent === false) {
    el.claudeState.hidden = true;
    el.claudeSentence.textContent =
      "Detecting a local tool needs the connection backend, and this build has none.";
    el.claudeDetail.textContent =
      "This build has no connection backend yet.";
    if (el.claudeVerify) el.claudeVerify.disabled = true;
    return;
  }
  const state = session.claudeProbed ? claudeStateOf() : null;
  if (state === null) {
    el.claudeState.hidden = true;
    el.claudeSentence.textContent = session.claudeProbed
      ? "The detection answer could not be read, so nothing is claimed about this machine."
      : "Looking for Claude Code on this machine.";
    el.claudeDetail.textContent = "";
    if (el.claudeVerify) el.claudeVerify.disabled = false;
  } else {
    el.claudeState.hidden = false;
    el.claudeState.dataset.connectionState = state;
    el.claudeState.title = connectionSentence[state];
    el.claudeStateCode.textContent = state;
    el.claudeSentence.textContent = connectionSentence[state];
    const detection = session.claude;
    el.claudeDetail.textContent =
      state === "NOT_CONFIGURED"
        ? "Claude Code was not found on this machine."
        : state === "DETECTED"
          ? "Claude Code was found. Its statusline command does not point at OpenLimiter yet."
          : detection !== null && detection.wired === true
            ? "Claude Code was found and its statusline command points at OpenLimiter."
            : "Claude Code was found.";
    if (el.claudeVerify) el.claudeVerify.disabled = false;
  }

  if (!el.claudeBody) return;

  const detection = session.claude;
  const wired = detection !== null && detection.wired === true;

  if (wired) {
    const actions = element("div", "conn-actions");
    const disconnectBtn = element("button", undefined, "Disconnect");
    disconnectBtn.type = "button";
    disconnectBtn.addEventListener("click", () => {
      void (async () => {
        disconnectBtn.disabled = true;
        setNote(el.claudeNote, "Disconnecting.", "plain");
        const result = await backend.claudeDisconnect();
        if (result.ok) {
          const outcome = result.value?.kind;
          if (outcome === "restored_exact") {
            setNote(
              el.claudeNote,
              "The previous settings were restored byte for byte from the timestamped copy.",
              "ok",
            );
          } else if (outcome === "removed_owned_entries") {
            setNote(
              el.claudeNote,
              "The settings file changed after OpenLimiter wrote to it, so the copy was not restored, and only the OpenLimiter entries were removed while everything else was left exactly as it is.",
              "ok",
            );
          } else if (outcome === "nothing_to_remove") {
            setNote(
              el.claudeNote,
              "There was nothing of OpenLimiter's to remove.",
              "plain",
            );
          } else {
            setNote(el.claudeNote, "Disconnected.", "ok");
          }
        } else {
          setNote(
            el.claudeNote,
            result.reason === backend.BACKEND_ABSENT
              ? "This build has no connection backend yet."
              : result.message,
            "bad",
          );
        }
        await runClaudePreflight();
        await detectClaude();
        render();
      })();
    });
    actions.append(disconnectBtn);
    el.claudeBody.append(actions);
    return;
  }

  const verdict = session.claudeVerdict;
  if (verdict === null) {
    const actions = element("div", "conn-actions");
    const verifyBtn = element("button", undefined, "Verify");
    verifyBtn.type = "button";
    verifyBtn.addEventListener("click", () => {
      void verifyClaude();
    });
    actions.append(verifyBtn);
    el.claudeBody.append(actions);
    return;
  }

  switch (verdict.kind) {
    case "ready":
    case "wrappable_status_line": {
      const wrappingStatusLine = verdict.kind === "wrappable_status_line";
      if (session.claudeConsentOpen) {
        const consentBox = element("div", "conn-block surface");
        const heading = element("h2", undefined, "Claude Code connection details");
        consentBox.append(heading);

        const explanation = element("div", "conn-detail");
        const p1 = element(
          "p",
          undefined,
          "The file that will change is the Claude Code settings file in your home directory.",
        );
        const p2 = element(
          "p",
          undefined,
          "A timestamped copy of that file is written beside it first, before any change.",
        );
        const p3 = element(
          "p",
          undefined,
          wrappingStatusLine
            ? "The existing statusLine command will be replaced by an OpenLimiter wrapper. It captures quota, then runs the existing command and returns its output unchanged. One OpenLimiter UserPromptSubmit hook will also be added. Both use this absolute command line tool path:"
            : "The two entries that will be added are the statusLine command and one UserPromptSubmit hook, both pointing at the absolute path of the OpenLimiter command line tool:",
        );
        const monoPath = element("pre", "mono", verdict.cliPath ?? "OpenLimiter CLI path");
        const p4 = element(
          "p",
          undefined,
          wrappingStatusLine
            ? "Disconnect restores the existing statusLine command exactly. Nothing else in the file is touched."
            : "Nothing else in the file is touched.",
        );
        const p5 = element(
          "p",
          undefined,
          "No credential, token or login file of any kind is read or written, ever.",
        );

        explanation.append(p1, p2, p3, monoPath, p4, p5);
        consentBox.append(explanation);

        const actions = element("div", "conn-actions");
        const applyBtn = element(
          "button",
          undefined,
          wrappingStatusLine ? "Write wrapper and hook" : "Write these two entries",
        );
        applyBtn.type = "button";

        const cancelBtn = element("button", undefined, "Cancel");
        cancelBtn.type = "button";

        applyBtn.addEventListener("click", () => {
          void (async () => {
            applyBtn.disabled = true;
            cancelBtn.disabled = true;
            setNote(
              el.claudeNote,
              wrappingStatusLine
                ? "Writing the timestamped backup copy, wrapper, and hook."
                : "Writing the timestamped backup copy and adding entries.",
              "plain",
            );
            const result = await backend.claudeConnectApply();
            if (result.ok) {
              const outcome = result.value?.kind;
              if (outcome === "applied") {
                setNote(
                  el.claudeNote,
                  wrappingStatusLine
                    ? "The wrapper and hook were written, and a timestamped copy of the previous settings sits beside the settings file."
                    : "The two entries were written and a timestamped copy of the previous settings sits beside the settings file.",
                  "ok",
                );
              } else if (outcome === "already_applied") {
                setNote(
                  el.claudeNote,
                  wrappingStatusLine
                    ? "The wrapper and hook were already in place, so nothing changed."
                    : "Those two entries were already in place, so nothing changed.",
                  "plain",
                );
              } else {
                setNote(el.claudeNote, "Applied configuration.", "ok");
              }
            } else {
              setNote(
                el.claudeNote,
                result.reason === backend.BACKEND_ABSENT
                  ? "This build has no connection backend yet."
                  : result.message,
                "bad",
              );
            }
            session.claudeConsentOpen = false;
            await runClaudePreflight();
            await detectClaude();
            render();
          })();
        });

        cancelBtn.addEventListener("click", () => {
          session.claudeConsentOpen = false;
          render();
        });

        actions.append(applyBtn, cancelBtn);
        consentBox.append(actions);
        el.claudeBody.append(consentBox);
      } else {
        const actions = element("div", "conn-actions");
        const connectBtn = element("button", undefined, "Connect");
        connectBtn.type = "button";
        // The consent box is not a step to be optimised away. It is the whole
        // reason this flow is allowed to exist: pressing Connect must never
        // write to a settings file the user owns before the user has seen what
        // will be written. Preflight resolves and executes an absolute CLI path
        // BEFORE any settings write, which is the order locked on 2026-08-11.
        // An agent removed both of those in this file once. Do not do it again.
        connectBtn.addEventListener("click", () => {
          session.claudeConsentOpen = true;
          render();
        });
        actions.append(connectBtn);
        el.claudeBody.append(actions);
      }
      break;
    }

    case "cli_missing": {
      const p = element(
        "p",
        "conn-detail",
        "Claude Code may be on this machine but the OpenLimiter command line tool is not, and the one click connection needs a real absolute path to it.",
      );
      const mono = element("pre", "mono", verdict.installCommand);
      const actions = element("div", "conn-actions");

      const copyBtn = element("button", undefined, "Copy install command");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", () => {
        void (async () => {
          try {
            await window.navigator.clipboard.writeText(verdict.installCommand);
            setNote(el.claudeNote, "Copied install command.", "ok");
          } catch {
            setNote(el.claudeNote, "Copying was refused.", "bad");
          }
        })();
      });

      const recheckBtn = element("button", undefined, "Check again");
      recheckBtn.type = "button";
      recheckBtn.addEventListener("click", () => {
        void (async () => {
          setNote(el.claudeNote, "Checking.", "plain");
          await runClaudePreflight();
          await detectClaude();
          render();
        })();
      });

      actions.append(copyBtn, recheckBtn);
      el.claudeBody.append(p, mono, actions);
      break;
    }

    case "cli_not_working": {
      const p = element(
        "p",
        "conn-detail",
        "The command line tool was found but did not answer when it was run, so nothing was written and nothing will be.",
      );
      const mono = element("pre", "mono", verdict.cliPath ?? "CLI path missing");
      const actions = element("div", "conn-actions");

      const recheckBtn = element("button", undefined, "Check again");
      recheckBtn.type = "button";
      recheckBtn.addEventListener("click", () => {
        void (async () => {
          setNote(el.claudeNote, "Checking.", "plain");
          await runClaudePreflight();
          await detectClaude();
          render();
        })();
      });

      actions.append(recheckBtn);
      el.claudeBody.append(p, mono, actions);
      break;
    }

    case "guided_manual": {
      let refusal = "OpenLimiter will not touch an entry somebody else put there.";
      if (verdict.foreignStatusLine && verdict.foreignUserPromptSubmitHooks) {
        refusal =
          "OpenLimiter will not touch a statusLine entry and a UserPromptSubmit hook that belong to another tool.";
      } else if (verdict.foreignStatusLine) {
        refusal =
          "OpenLimiter will not touch a statusLine entry that belongs to another tool.";
      } else if (verdict.foreignUserPromptSubmitHooks) {
        refusal =
          "OpenLimiter will not touch a UserPromptSubmit hook that belongs to another tool.";
      }

      const refusalP = element("p", "conn-detail", refusal);
      const instructionP = element(
        "p",
        "conn-lead",
        "Merge the block below into your settings file by hand, then press Verify.",
      );
      const mono = element("pre", "mono", CLAUDE_SETUP_SNIPPET);

      const actions = element("div", "conn-actions");
      const copyBtn = element("button", undefined, "Copy settings block");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", () => {
        void copyClaudeSnippet();
      });

      const verifyBtn = element("button", undefined, "Verify");
      verifyBtn.type = "button";
      verifyBtn.addEventListener("click", () => {
        void verifyClaude();
      });

      actions.append(copyBtn, verifyBtn);
      el.claudeBody.append(refusalP, instructionP, mono, actions);
      break;
    }

    case "settings_unknown": {
      const p = element(
        "p",
        "conn-detail",
        "The settings file is not in a shape this build understands, so nothing was written.",
      );
      const instructionP = element(
        "p",
        "conn-lead",
        "Merge the block below into your settings file by hand, then press Verify.",
      );
      const mono = element("pre", "mono", CLAUDE_SETUP_SNIPPET);

      const actions = element("div", "conn-actions");
      const copyBtn = element("button", undefined, "Copy settings block");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", () => {
        void copyClaudeSnippet();
      });

      const verifyBtn = element("button", undefined, "Verify");
      verifyBtn.type = "button";
      verifyBtn.addEventListener("click", () => {
        void verifyClaude();
      });

      actions.append(copyBtn, verifyBtn);
      el.claudeBody.append(p, instructionP, mono, actions);
      break;
    }
  }
}

/** Render the provider catalogue using live connection evidence only. */
function renderCatalogue() {
  if (!el.catalogueRows) return;
  el.catalogueRows.textContent = "";

  const states = {};

  const claudeState = claudeStateOf();
  if (claudeState !== null) {
    states.claude = claudeState;
  }

  const records = {};
  const providers = ["openrouter", "codex", "antigravity", "opencode"];
  for (const id of providers) {
    const matching = session.connections.filter(
      (entry) => typeof entry.provider === "string" && entry.provider.toLowerCase() === id,
    );
    if (matching.length > 0) {
      const best = matching.find((entry) => entry.state === "CONNECTED") ?? matching[0];
      records[id] = best;
      const validStates = matching.map((e) => e.state).filter((s) => KNOWN_STATES.has(s));
      if (validStates.length > 0) {
        states[id] = mostConstrainedState(validStates);
      }
    }
  }

  const rows = queryCatalogueRows(PROVIDER_SPECS, states);

  for (const rowData of rows) {
    const rowEl = element("div", "catalogue-row");

    const identEl = element("div", "catalogue-ident");
    identEl.append(element("span", "name", rowData.displayName));

    if (rowData.availability === "connectable") {
      identEl.append(stateChip(rowData.connectionState));
    } else {
      const plannedChip = element("span", "chip muted", "Planned");
      identEl.append(plannedChip);
    }
    rowEl.append(identEl);

    if (rowData.availability === "connectable") {
      const caps = rowData.capabilities;
      const platformText =
        "Windows " +
        caps.windows.label +
        " · macOS " +
        caps.macos.label +
        " · Linux " +
        caps.linux.label;
      rowEl.append(element("div", "catalogue-platforms", platformText));

      const actionEl = element("div", "catalogue-action");
      const btn = element("button", undefined, rowData.action);
      btn.type = "button";
      const targetId = {
        claude: "claude-card",
        openrouter: "openrouter-add",
        codex: "codex-add",
        antigravity: "antigravity-add",
        opencode: "opencode-add",
      }[rowData.providerId];

      btn.addEventListener("click", () => {
        if (rowData.action === connectionNextAction.CONNECTED) {
          const record = records[rowData.providerId];
          if (record === undefined) return;
          void (async () => {
            btn.disabled = true;
            await refreshNow(record);
            render();
          })();
          return;
        }
        if (rowData.action === connectionNextAction.ERROR) {
          const diagnosticsTab = document.getElementById("tab-advanced");
          if (diagnosticsTab) diagnosticsTab.click();
          const diagnosticsPanel = document.getElementById("panel-advanced");
          if (diagnosticsPanel) diagnosticsPanel.focus();
          return;
        }
        /* Every remaining state is a setup shaped action: not configured,
           detected, needs auth, expired, ready to enable. Each one resolves
           by taking the person to the provider's own setup card, so the
           default is that card rather than a silently dropped click. */
        if (targetId) {
          const targetEl = document.getElementById(targetId);
          if (targetEl) {
            targetEl.hidden = false;
            const expandId = targetId.replace("-add", "-expand");
            const expandEl = document.getElementById(expandId);
            const toggleBtn = document.getElementById(targetId.replace("-add", "-toggle-btn"));
            if (expandEl && toggleBtn) {
              expandEl.hidden = false;
              toggleBtn.setAttribute("aria-expanded", "true");
            }
            targetEl.scrollIntoView({ behavior: "smooth" });
            targetEl.focus();
          }
        }
      });
      actionEl.append(btn);
      rowEl.append(actionEl);
    }
    /* A planned row gets no action column at all. The chip beside its name
       already says Planned, and printing the same word twice in one row reads
       as two facts when there is only one. There is nothing to press, so there
       is nothing here. */

    el.catalogueRows.append(rowEl);
  }
}

function render() {
  if (!session.ready) return;
  const now = new Date().toISOString();
  renderSchedulerLine();

  const absent = session.backendPresent === false;
  el.absent.hidden = !absent;
  el.openrouterAdd.hidden = absent || session.backendPresent === null;

  const setupProviders = ["openrouter", "codex", "antigravity", "opencode"];
  for (const id of setupProviders) {
    const chip = document.getElementById(id + "-status-chip");
    const code = document.getElementById(id + "-status-code");
    const btn = document.getElementById(id + "-toggle-btn");
    const matching = session.connections.filter(
      (entry) => typeof entry.provider === "string" && entry.provider.toLowerCase() === id,
    );
    const hasConnections = matching.length > 0;
    const isConnected = matching.some((entry) => entry.state === "CONNECTED");
    const state = hasConnections
      ? mostConstrainedState(matching.map((entry) => entry.state))
      : "NOT_CONNECTED";
    if (chip && code) {
      chip.dataset.connectionState = state;
      code.textContent = stateWord(state);
      chip.title = sentenceFor(state);
    }
    if (btn) {
      const isExpanded = btn.getAttribute("aria-expanded") === "true";
      if (!isExpanded) {
        btn.textContent = isConnected ? "Reconnect" : "Connect";
      }
    }
    renderProviderAccounts(id, matching, now);
  }

  const claudeMatching = session.connections.filter(
    (entry) => typeof entry.provider === "string" && entry.provider.toLowerCase() === "claude",
  );
  renderProviderAccounts("claude", claudeMatching, now);

  if (el.cards) el.cards.textContent = "";
  if (session.backendPresent === true && session.listError !== null && el.cards) {
    const line = element("p", "conn-note");
    line.dataset.tone = "bad";
    line.setAttribute("role", "status");
    line.textContent = "Listing connections failed: " + session.listError;
    el.cards.append(line);
  }
  el.empty.hidden = !(
    session.backendPresent === true &&
    session.connections.length === 0 &&
    session.listError === null
  );

  renderClaude();
  renderCatalogue();
}

/* ---------------------------------------------------------------- actions */

async function submitOpenrouter() {
  const input = el.openrouterKey;
  const kindChoice = el.openrouterKind();
  const kind = kindChoice === null ? "api_key" : kindChoice.value;
  const secret = input.value.trim();
  /* Cleared before anything else happens, success or failure, so the secret
     never sits in a form field while a request is in flight. */
  input.value = "";
  if (secret === "") {
    setNote(el.openrouterNote, "Nothing was pasted, so nothing was stored.", "bad");
    return;
  }
  /* The contract wants an alias on every connection, because account
     identity is first class. An unnamed account is honestly called default,
     which is what it is until a second account makes a name matter. */
  const alias = el.openrouterAlias.value.trim() || "default";
  el.openrouterSubmit.disabled = true;
  setNote(el.openrouterNote, "Storing the key in the credential store.", "plain");
  /* The two OpenRouter credential kinds, as the wire spells them. A stored
     and untested credential lands in READY_TO_ENABLE, which the backend
     derives: this window no longer states a starting state. */
  const credentialKind = /management/iu.test(String(kind))
    ? "openrouter_management_key"
    : "openrouter_inference_key";
  const connected = await backend.connectProvider({
    providerId: "openrouter",
    credentialKind,
    accountAlias: alias,
    secret,
  });
  if (!connected.ok) {
    if (connected.reason === backend.BACKEND_ABSENT) {
      session.backendPresent = false;
      setNote(el.openrouterNote, "This build has no connection backend yet.", "bad");
    } else {
      setNote(el.openrouterNote, "Connecting failed. " + connected.message, "bad");
    }
    el.openrouterSubmit.disabled = false;
    render();
    return;
  }
  await syncConnections();
  const returned =
    typeof connected.value === "string"
      ? connected.value
      : (backend.normalizeConnection(connected.value)?.id ?? null);
  const record =
    (returned !== null
      ? session.connections.find((entry) => entry.id === returned)
      : undefined) ??
    session.connections.filter((entry) => entry.provider === "OPENROUTER").at(-1);
  if (record === undefined) {
    setNote(
      el.openrouterNote,
      "The key was stored, and no connection record came back to test.",
      "bad",
    );
    el.openrouterSubmit.disabled = false;
    render();
    return;
  }
  setNote(el.openrouterNote, "Stored. Testing the connection now.", "plain");
  const asked = await runTest(record);
  if (asked.absent) {
    setNote(el.openrouterNote, "This build has no connection backend yet.", "bad");
    el.openrouterSubmit.disabled = false;
    render();
    return;
  }
  const settled = session.connections.find((entry) => entry.id === record.id);
  if (asked.note !== null) {
    setNote(el.openrouterNote, "The test failed. " + asked.note, "bad");
  } else {
    setNote(
      el.openrouterNote,
      "Test finished. " + sentenceFor(settled?.state ?? record.state),
      asked.succeeded ? "ok" : "bad",
    );
  }
  el.openrouterAlias.value = "";
  el.openrouterSubmit.disabled = false;
  render();
}

async function copyClaudeSnippet() {
  try {
    await window.navigator.clipboard.writeText(CLAUDE_SETUP_SNIPPET);
    setNote(
      el.claudeNote,
      "Copied. Add it to your Claude Code settings.json, then press Verify.",
      "ok",
    );
  } catch {
    /* Clipboard refused. The block is selectable, so select it for the
       person instead of failing with nothing to show. */
    const selection = window.getSelection();
    if (selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(el.claudeSnippet);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setNote(
      el.claudeNote,
      "Copying was refused here, so the block is selected. Copy it by hand.",
      "bad",
    );
  }
}

async function verifyClaude() {
  if (el.claudeVerify) el.claudeVerify.disabled = true;
  setNote(el.claudeNote, "Detecting.", "plain");
  await detectClaude();
  await runClaudePreflight();
  const state = claudeStateOf();
  setNote(
    el.claudeNote,
    state === null
      ? "Detection is not available in this build."
      : connectionSentence[state],
    state === null ? "bad" : "plain",
  );
  render();
}

/* ------------------------------------------------------------------ public */

/**
 * What the meters view may say about a provider's connection.
 *
 * Null when there is nothing to say: no backend, or no record for this
 * provider. Otherwise the record's state and whether a live refresh has
 * actually succeeded in this run, which is the one fact that permits the
 * word Connected on a meters row.
 */
export function connectionFactFor(provider) {
  if (session.backendPresent !== true) return null;
  const records = session.connections.filter((entry) => entry.provider === provider);
  if (records.length === 0) return null;
  const best =
    records.find((entry) => entry.state === "CONNECTED") ?? records[0];
  return {
    state: KNOWN_STATES.has(best.state) ? best.state : null,
    liveOk: best.state === "CONNECTED",
  };
}

/**
 * The meters just re-read the cache. The Claude card's split between ready
 * and collecting depends on that cache, so it is redrawn.
 */
export function noteMetersRefreshed() {
  if (!session.ready) return;
  renderClaude();
}

/**
 * The Connections tab was brought on screen. On a build where the backend
 * probe said absent this asks again, because the person may have switched
 * builds under the same profile, and a stale absent block would be a claim
 * about the wrong build.
 */
export function connectionsTabShown() {
  if (!session.ready) return;
  void (async () => {
    await syncConnections();
    await syncCollectorStatus();
    if (session.backendPresent === true) {
      await detectClaude();
      await runClaudePreflight();
    }
    render();
  })();
}

async function bootstrap() {
  await syncConnections();
  await syncCollectorStatus();
  if (session.backendPresent === true) {
    await detectClaude();
    await runClaudePreflight();
  }
  render();
}

export function initConnections(configuration) {
  options = configuration;
  grabElements();
  session.ready = true;

  const setupProviders = ["openrouter", "codex", "antigravity", "opencode"];
  for (const id of setupProviders) {
    const btn = document.getElementById(id + "-toggle-btn");
    const expand = document.getElementById(id + "-expand");
    if (btn && expand) {
      btn.addEventListener("click", () => {
        const isExpanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", isExpanded ? "false" : "true");
        expand.hidden = isExpanded;
      });
    }
  }

  el.reprobe.addEventListener("click", () => {
    void bootstrap();
  });
  el.openrouterSubmit.addEventListener("click", () => {
    void submitOpenrouter();
  });
  el.claudeCopy.addEventListener("click", () => {
    void copyClaudeSnippet();
  });
  if (el.claudeVerify) {
    el.claudeVerify.addEventListener("click", () => {
      void verifyClaude();
    });
  }

  void backend.listen(COLLECTOR_UPDATED_EVENT, () => {
    void (async () => {
      await syncCollectorStatus();
      await syncConnections();
      options.onMetersChanged();
      render();
    })();
  });
  void bootstrap();
}
