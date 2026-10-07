/**
 * What the one screen's tool rows do when pressed.
 *
 * Every claim is about this exact build, verified through the backend adapter
 * before it is drawn. A connection exists only because list_connections
 * returned its record, Claude Code's setup state comes from
 * detect_local_tools and the preflight, and a key is stored only through
 * connect_provider. A build without those commands (a static serve of these
 * files) answers false from every step, and the row says that did not work.
 *
 * Two kinds of step, the two a row's button can carry:
 *
 *   connect, for a tool this window can set up itself: Claude Code's settings
 *   block, Codex's login import, a session token for Antigravity or OpenCode,
 *   and OpenRouter's key (whose field is in the key rows, owned by app.js);
 *
 *   check, for a sign in that lives in the tool itself: the person signs in
 *   or opens it there, and this asks native code to look again and read once.
 *
 * The whole collection transaction belongs to Rust. Its schedule, reads,
 * cache fold and backoff continue when this window is hidden; a
 * collector-updated event only asks for a reread.
 */
import { CONNECTION_STATES } from "./engine/core/index.js";
import { buildProviderDirectory } from "./engine/ui/provider-connect.js";
import { PROVIDER_SPECS } from "./provider-specs.generated.js";
import { configureProvider, readRemovedProviders } from "./configured-providers.js";
import * as backend from "./backend.js";
import { providerCode, providerName, say } from "./names.js";

/** The event Rust emits after a native collection pass changes observable state. */
const COLLECTOR_UPDATED_EVENT = "collector-updated";

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
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "openlimiter hook"
          }
        ]
      }
    ]
  }
}`;

// English catalog for the setup panels. L7 owns translations.
export const SETUP_EN = Object.freeze({
  ready: "Add this to your Claude Code settings, then Verify.",
  wrappable: "Another status line is set. Combine them by hand, then Verify.",
  guided: "Another tool owns these settings. Merge this by hand, then Verify.",
  unknownShape: "Settings file not understood. Merge this by hand, then Verify.",
  cliMissing: "Install the OpenLimiter command first.",
  cliNotWorking: "The OpenLimiter command did not answer.",
  runtimeMissing: say("runtimeMissing"),
  runtimeOutdated: say("runtimeOutdated"),
  copy: "Copy",
  copied: "Copied",
  copyRefused: "Copy refused, select it by hand",
  verify: "Verify",
  checkAgain: "Check again",
  close: "Close",
  save: "Save",
  stored: "Saved, checking",
  nothing: "Nothing was pasted",
  noBackend: "Not available in this build",
});

const session = {
  ready: false,
  backendPresent: null,
  connections: [],
  /** The last detect_local_tools answer for Claude Code, normalized. */
  claude: null,
  claudeProbed: false,
  /** The preflight verdict for Claude Code's settings. */
  claudeVerdict: null,
  runtime: null,
  /** The one setup panel open under the list, or null. */
  activeSetup: null,
};

/** Wired by initConnections. Nothing here runs before that. */
let options = null;

/* The setup panels under the list, by the tool each one sets up. */
const SETUP_TARGETS = { CLAUDE: "claude-card", ANTIGRAVITY: "antigravity-add", OPENCODE: "opencode-add" };

/* The closed wire words for the remaining pasted credential. */
const PASTED = {
  OPENCODE: { providerId: "opencode", credentialKind: "opencode_browser_session" },
};

const ANTIGRAVITY_SETUP_COMMAND = "openlimiter terminal install antigravity";

/* ----------------------------------------------------------------- backend */

async function syncConnections() {
  const result = await backend.listConnections();
  if (!result.ok) {
    if (result.reason === backend.BACKEND_ABSENT) {
      session.backendPresent = false;
      session.connections = [];
    }
    return;
  }
  session.backendPresent = true;
  session.connections = backend.normalizeConnectionList(result.value);
}

/** The records one tool holds, as list_connections last answered. */
export function recordsFor(code) {
  return session.connections.filter((entry) => providerCode(entry.provider) === code);
}

/** Probe and parse once, without committing: proves a stored credential reads. */
async function runTest(record) {
  const result = await backend.testProvider({ connectionId: record.id });
  if (!result.ok) return { succeeded: false, note: result.reason === backend.BACKEND_ABSENT ? SETUP_EN.noBackend : result.message };
  const outcome = backend.normalizeCollectionOutcome(result.value);
  await syncConnections();
  return { succeeded: outcome.kind === "tested", note: outcome.succeeded ? null : outcome.message };
}

/** One collection read for one record, committed to the cache by Rust. */
async function refreshNow(record) {
  const result = await backend.refreshProvider({ connectionId: record.id });
  await syncConnections();
  return result.ok && backend.normalizeCollectionOutcome(result.value).kind === "cache_committed";
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
 * The detect_local_tools answer, reduced to the three facts setup needs: was
 * Claude Code found, is the statusline pointed at OpenLimiter, and did the
 * backend hand over a state of its own. Anything unreadable is null, and null
 * is drawn as not knowing rather than as either answer.
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
  const found = pick(entry, ["claude_settings_present", "claudeSettingsPresent", "installed", "present", "found", "detected"]);
  const wired = pick(entry, ["statuslineWired", "statusline_wired", "statuslineConfigured", "statusline_configured", "wired", "configured"]);
  const state = pick(entry, ["state", "status"]);
  return {
    found: typeof found === "boolean" ? found : null,
    wired: typeof wired === "boolean" ? wired : null,
    state: typeof state === "string" && KNOWN_STATES.has(state) ? state : null,
  };
}

const VERDICTS = new Set(["ready", "wrappable_status_line", "cli_missing", "cli_not_working", "settings_unknown", "guided_manual"]);

/** The preflight verdict, read defensively; an unreadable one is null. */
function normalizePreflight(value) {
  if (value === null || typeof value !== "object") return null;
  const kind = pick(value, ["kind"]);
  if (typeof kind !== "string" || !VERDICTS.has(kind)) return null;
  const cliPath = pick(value, ["cli_path", "cliPath"]);
  const installCommand = pick(value, ["install_command", "installCommand"]);
  return {
    kind,
    cliPath: typeof cliPath === "string" ? cliPath : null,
    installCommand: typeof installCommand === "string" ? installCommand : "npm install -g openlimiter",
  };
}

async function runClaudePreflight() {
  const result = await backend.claudeConnectPreflight();
  session.claudeVerdict = result.ok ? normalizePreflight(result.value) : null;
  if (!result.ok && result.reason === backend.BACKEND_ABSENT) session.backendPresent = false;
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
 * Claude Code's setup state, in the core's own vocabulary: not found is
 * NOT_CONFIGURED, found but not wired is DETECTED, wired splits on whether a
 * fresh statusline reading is in the cache right now (CONNECTED) or not yet
 * (READY_TO_ENABLE). Null means detection itself was impossible.
 */
export function claudeState() {
  const detection = session.claude;
  if (detection === null) return null;
  if (detection.state !== null) return detection.state;
  if (detection.found === null) return null;
  if (detection.found === false) return "NOT_CONFIGURED";
  if (detection.wired !== true) return "DETECTED";
  return options?.hasFreshLocalClaude() ? "CONNECTED" : "READY_TO_ENABLE";
}

/* ---------------------------------------------------------------- dom kit */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, onClick, className = "q-btn q-btn-ghost") {
  const control = element("button", className, text);
  control.type = "button";
  control.addEventListener("click", onClick);
  return control;
}

function setNote(node, text, tone) {
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone ?? "plain";
}

/* ------------------------------------------------------------ claude setup */

async function copyClaudeSnippet(note, block) {
  try {
    await window.navigator.clipboard.writeText(CLAUDE_SETUP_SNIPPET);
    setNote(note, SETUP_EN.copied, "ok");
  } catch {
    /* Clipboard refused. The block is selectable, so select it instead. */
    const selection = window.getSelection();
    if (selection !== null && block) {
      const range = document.createRange();
      range.selectNodeContents(block);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setNote(note, SETUP_EN.copyRefused, "bad");
  }
}

async function verifyClaude() {
  await refreshRuntime();
  await detectClaude();
  await runClaudePreflight();
  options?.onMetersChanged();
  render();
}

function compareRuntimeVersions(left, right) {
  const parse = (value) => {
    const parts = String(value ?? "").match(/^\d+(?:\.\d+){0,3}/u);
    return parts === null ? null : parts[0].split(".").map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  if (a === null || b === null) return null;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function runtimeState(runtime) {
  if (runtime === null) return null;
  if (!runtime.version) return "missing";
  const comparison = compareRuntimeVersions(runtime.version, runtime.appVersion);
  return comparison === null || comparison === 0 ? "current" : comparison < 0 ? "older" : "newer";
}

function appendRuntimeGuidance(body, host) {
  const runtime = session.runtime;
  if (runtime?.version) body.append(element("p", "q-setup-line", say("runtimeInstalled", { version: runtime.version })));
  const state = runtimeState(runtime);
  if (state === "older" || state === "missing") {
    const command = element("pre", "q-snippet mono", say("runtimeInstall", { host }));
    body.append(element("p", "q-setup-line", state === "older" ? SETUP_EN.runtimeOutdated : SETUP_EN.runtimeMissing), command);
  } else if (state === "newer") {
    body.append(element("p", "q-setup-line", say("runtimeNewer")));
  }
}

/* The Claude setup panel: one short line, the block, and its two controls. */
function renderClaude() {
  const body = document.getElementById("claude-body");
  const note = document.getElementById("claude-note");
  if (!body) return;
  body.textContent = "";
  const verdict = session.claudeVerdict;
  const recheck = button(SETUP_EN.checkAgain, () => void verifyClaude());
  const verify = button(SETUP_EN.verify, () => void verifyClaude(), "q-btn q-btn-primary");
  const actions = element("div", "q-setup-actions");
  appendRuntimeGuidance(body, "claude");
  if (verdict?.kind === "cli_missing" || verdict?.kind === "cli_not_working") {
    const missing = verdict.kind === "cli_missing";
    const line = element("pre", "q-snippet mono", missing ? verdict.installCommand : (verdict.cliPath ?? ""));
    body.append(element("p", "q-setup-line", missing ? SETUP_EN.cliMissing : SETUP_EN.cliNotWorking), line);
    if (missing) {
      actions.append(button(SETUP_EN.copy, async () => {
        try {
          await window.navigator.clipboard.writeText(verdict.installCommand);
          setNote(note, SETUP_EN.copied, "ok");
        } catch {
          setNote(note, SETUP_EN.copyRefused, "bad");
        }
      }));
    }
    actions.append(recheck);
    body.append(actions);
    return;
  }
  const lead = {
    wrappable_status_line: SETUP_EN.wrappable,
    guided_manual: SETUP_EN.guided,
    settings_unknown: SETUP_EN.unknownShape,
  }[verdict?.kind] ?? SETUP_EN.ready;
  const block = element("pre", "q-snippet mono", CLAUDE_SETUP_SNIPPET);
  body.append(element("p", "q-setup-line", lead), block);
  if (verdict?.kind !== "wrappable_status_line") actions.append(button(SETUP_EN.copy, () => void copyClaudeSnippet(note, block)));
  actions.append(verify);
  body.append(actions);
}

function renderAntigravity() {
  const body = document.getElementById("antigravity-body");
  const note = document.getElementById("antigravity-note");
  if (!body) return;
  body.textContent = "";
  appendRuntimeGuidance(body, "antigravity");
  const block = element("pre", "q-snippet mono", ANTIGRAVITY_SETUP_COMMAND);
  const actions = element("div", "q-setup-actions");
  actions.append(button(SETUP_EN.copy, async () => {
    try {
      await window.navigator.clipboard.writeText(ANTIGRAVITY_SETUP_COMMAND);
      setNote(note, SETUP_EN.copied, "ok");
    } catch {
      setNote(note, SETUP_EN.copyRefused, "bad");
    }
  }));
  body.append(element("p", "q-setup-line", say("antigravitySetupNote")), block, actions);
}

/* ------------------------------------------------------------------ render */

function render() {
  if (!session.ready) return;
  for (const [code, targetId] of Object.entries(SETUP_TARGETS)) {
    const target = document.getElementById(targetId);
    if (target) target.hidden = session.activeSetup !== code;
  }
  renderClaude();
  renderAntigravity();
}

/** Open one setup panel under the list, close any other, and focus it. */
function openSetup(code) {
  session.activeSetup = code;
  render();
  const target = document.getElementById(SETUP_TARGETS[code]);
  target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  (target?.querySelector?.("input, button.q-btn-primary") ?? target)?.focus?.({ preventScroll: true });
}

/**
 * Store one pasted credential and prove it reads: connect_provider, then one
 * test. The field is cleared before anything is sent. A second account of a
 * tool gets its own alias so two accounts stay apart.
 */
async function savePasted(code, input, note, control) {
  const secret = String(input?.value ?? "").trim();
  if (input) input.value = "";
  if (secret === "") {
    setNote(note, SETUP_EN.nothing, "bad");
    return false;
  }
  control.disabled = true;
  const result = await connectCredential(code, PASTED[code], secret);
  control.disabled = false;
  setNote(note, result.ok ? SETUP_EN.stored : result.note, result.ok ? "ok" : "bad");
  if (result.ok) {
    session.activeSetup = null;
    render();
  }
  return result.ok;
}

async function connectCredential(code, { providerId, credentialKind }, secret) {
  const existing = recordsFor(code).length;
  const connected = await backend.connectProvider({
    providerId,
    credentialKind,
    accountAlias: existing === 0 ? "default" : "account " + String(existing + 1),
    secret,
  });
  if (!connected.ok) {
    if (connected.reason === backend.BACKEND_ABSENT) session.backendPresent = false;
    return { ok: false, note: connected.reason === backend.BACKEND_ABSENT ? SETUP_EN.noBackend : connected.message };
  }
  await syncConnections();
  const id = typeof connected.value === "string" ? connected.value : (backend.normalizeConnection(connected.value)?.id ?? null);
  const record = session.connections.find((entry) => entry.id === id) ?? recordsFor(code).at(-1);
  if (record !== undefined) {
    const tested = await runTest(record);
    if (!tested.succeeded && tested.note !== null) return { ok: false, note: tested.note };
  }
  configureProvider(providerId);
  options?.onMetersChanged();
  return { ok: true, note: null };
}

/* ------------------------------------------------------------------ public */

/**
 * Save OpenRouter's key from its key row: the quota connection, proved with
 * one test. Answers what the key row needs to word a refusal.
 */
export async function saveOpenrouterKey(secret, credentialKind = "openrouter_inference_key") {
  const result = await connectCredential("OPENROUTER", { providerId: "openrouter", credentialKind }, secret);
  return result.ok ? { ok: true } : { ok: false, kind: "ineligible_or_revoked", note: result.note };
}

/** Replace one OpenRouter key in place after native provider validation. */
export async function replaceOpenrouterKey(recordId, secret) {
  const result = await backend.replaceConnectionSecret(recordId, secret);
  if (!result.ok) {
    return { ok: false, kind: result.kind ?? null, note: result.message ?? null };
  }
  await syncConnections();
  configureProvider("openrouter");
  options?.onMetersChanged();
  return { ok: true };
}

/**
 * The connect step. Codex imports its own login file in one press; Claude
 * Code, Antigravity and OpenCode open their setup panel under the list.
 * Resolves false when nothing could be done.
 */
export async function connectTool(code) {
  if (code === "CODEX") {
    const refused = recordsFor("CODEX").find((r) => ["NEEDS_AUTH", "AUTH_EXPIRED", "ERROR"].includes(r.state));
    if (refused) {
      const result = await backend.repairCodexConnection(refused.id);
      if (result.ok) {
        const outcome = backend.normalizeCollectionOutcome(result.value);
        if (outcome.succeeded) {
          await syncConnections();
          options?.onMetersChanged();
          return true;
        }
        return outcome.message;
      }
      return result.reason === backend.BACKEND_ABSENT ? SETUP_EN.noBackend : result.message;
    }
    /* The backend imports the token from the Codex login file and discards
       what this window sends, so the secret here is a placeholder. */
    const result = await connectCredential("CODEX", { providerId: "codex", credentialKind: "codex_session" }, "imported from the codex login file");
    return result.ok ? true : (result.note ?? false);
  }
  if (SETUP_TARGETS[code]) {
    configureProvider(code);
    if (code === "CLAUDE") {
      await detectClaude();
      await runClaudePreflight();
    }
    openSetup(code);
    return true;
  }
  return checkTool(code);
}

/**
 * The check step: read again what can be read. Stored connections refresh
 * now; local tools are scanned for again (the person signed in or opened the
 * tool there, OpenLimiter never refreshes a sign in itself) and read once.
 */
export async function checkTool(code) {
  const records = recordsFor(code);
  const refreshed = records.length ? (await Promise.all(records.map(refreshNow))).some(Boolean) : false;
  const scanned = await backend.rescanDetectedProviders();
  if (code === "CLAUDE") {
    await detectClaude();
    await runClaudePreflight();
  }
  const read = await backend.refreshHome([code]);
  options?.onMetersChanged();
  render();
  return refreshed || (scanned.ok && read.ok);
}

/** Refresh one stored connection now, for the key row bound to it. */
export async function refreshConnection(id) {
  const ok = await refreshNow({ id });
  options?.onMetersChanged();
  return { ok };
}

/** Remove one stored connection and its credential. */
export async function removeConnection(id) {
  const result = await backend.disconnectProvider(id);
  await syncConnections();
  options?.onMetersChanged();
  return result.ok ? { ok: true } : { ok: false, kind: result.kind ?? null };
}

/**
 * The catalogue behind Add a tool: every tool this build can read that is
 * not in play, each with the same one step its row would have. A tool a
 * person switched off comes back on when it is chosen here.
 */
export function catalogueModel(inPlay) {
  const shown = new Set(inPlay);
  return buildProviderDirectory(PROVIDER_SPECS, { states: {} })
    .filter((row) => row.availability === "ready" && row.connectorId !== null)
    .map((row) => providerCode(row.connectorId))
    .filter((code) => !shown.has(code))
    .map((code) => ({
      code,
      name: providerName(code),
      windows: [],
      age: null,
      note: null,
      action: SETUP_TARGETS[code] || code === "CODEX"
        ? { kind: "connect", label: say("connect"), title: null }
        : { kind: "check", label: say("fixOpenAppAction"), title: say("fixToolDetail", { name: providerName(code) }) },
      extra: [],
    }));
}

/** Choose a tool from the catalogue: back on if it was off, then its step. */
export async function chooseTool(code, kind) {
  if (readRemovedProviders().includes(code)) {
    const switched = await backend.setProviderEnabled(code, true);
    if (!switched.ok) return false;
  }
  configureProvider(code);
  return kind === "connect" ? connectTool(code) : checkTool(code);
}

/**
 * The meters just re-read the cache. Claude Code's split between ready and
 * collecting depends on that cache.
 */
export function noteMetersRefreshed() {
  if (session.ready) renderClaude();
}

async function bootstrap() {
  await syncConnections();
  await refreshRuntime();
  if (session.backendPresent !== false) {
    await detectClaude();
    await runClaudePreflight();
  }
  render();
  options?.onMetersChanged();
}

async function refreshRuntime() {
  const runtime = await backend.terminalRuntimeStatus();
  session.runtime = runtime.ok && runtime.value && typeof runtime.value === "object"
    ? { version: typeof runtime.value.version === "string" ? runtime.value.version : null, appVersion: typeof runtime.value.app_version === "string" ? runtime.value.app_version : null }
    : null;
}

/** Wire the setup panels and the collector event, then read once. */
export function initConnections(configuration) {
  options = configuration;
  session.ready = true;
  for (const code of Object.keys(SETUP_TARGETS)) {
    const panel = document.getElementById(SETUP_TARGETS[code]);
    panel?.querySelector?.("[data-setup-close]")?.addEventListener("click", () => {
      session.activeSetup = null;
      render();
    });
    const save = panel?.querySelector?.("[data-setup-save]");
    if (save && PASTED[code]) {
      const input = panel.querySelector("input");
      const note = panel.querySelector("[data-setup-note]");
      save.addEventListener("click", () => void savePasted(code, input, note, save));
    }
  }
  void backend.listen(COLLECTOR_UPDATED_EVENT, () => {
    void syncConnections().then(() => options.onMetersChanged());
  });
  void bootstrap();
}
