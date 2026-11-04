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
 *   connect, for a tool this window can set up itself: Claude Code's install
 *   commands, Codex's login import, a session token for Antigravity or OpenCode,
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
/* This build's own version, written by build-ui.mjs from the same source as
   the Settings version line. Every pinned command names it, never the
   runtime stamp, so a stamp that cannot be read never takes a command away. */
import { version as APP_VERSION } from "./whats-new-data.js";

/** The event Rust emits after a native collection pass changes observable state. */
const COLLECTOR_UPDATED_EVENT = "collector-updated";

const KNOWN_STATES = new Set(CONNECTION_STATES);

// English catalog for the setup panels. L7 owns translations.
export const SETUP_EN = Object.freeze({
  claudeLead: "Shows your Claude Code limits here and under its prompt. Set up adds OpenLimiter's status line and prompt hook to Claude Code.",
  replacesStatusLine: "Your own status line will be replaced. Set up keeps a backup of it.",
  claudeStepSetUp: "Set up Claude Code",
  claudeStepVerify: "Send any message in Claude Code, then verify",
  antigravityLead: "Antigravity shares its limits through OpenLimiter's status line in Antigravity CLI.",
  antigravityStepSetUp: "Set up Antigravity",
  antigravityStepUsage: "Run /usage once in Antigravity CLI, then check again",
  opencodeLead: "OpenLimiter reads the sign in OpenCode saved on this computer, so there is nothing to paste. It has not found one that works yet.",
  opencodeStepSignIn: "Sign in to OpenCode in any terminal",
  opencodeStepCheck: "Come back and check again",
  opencodeNotYet: "Still no OpenCode sign in that works. Sign in first, or use a key below.",
  opencodeKeyHead: "Or use an OpenCode API key",
  opencodeKeyField: "OpenCode API key",
  getKey: "Get a key",
  manualHead: "Run it in a terminal instead",
  manualClaude: "Run these two commands in order, then verify.",
  setUp: "Set up",
  settingUp: "Setting up",
  setUpDone: "Set up finished.",
  setUpFailed: "Set up did not finish. Run the commands below in a terminal instead.",
  setUpNeedsNode: "Set up needs Node.js. Install it from nodejs.org and press Set up again, or run the commands below.",
  setUpBusy: "Set up is already running.",
  opencodeFound: "Found your OpenCode sign in. Its bars appear in Usage.",
  runtimeOutdatedVersion: "Your terminal runtime is {version}, older than this app. Set up updates it.",
  runtimeMissing: "The terminal runtime is not installed yet. Set up installs it.",
  copy: "Copy",
  copied: "Copied",
  copyRefused: "Copy refused, select it by hand",
  verify: "Verify",
  checkAgain: "Check again",
  checking: "Checking",
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
  /** The host whose Set up is running, kept here because panels redraw. */
  settingUp: null,
  /** The host whose last Set up failed: its commands stay unfolded. */
  setupFailed: null,
};

/** Wired by initConnections. Nothing here runs before that. */
let options = null;

/* The setup panels under the list, by the tool each one sets up. */
const SETUP_TARGETS = { CLAUDE: "claude-card", ANTIGRAVITY: "antigravity-add", OPENCODE: "opencode-add" };
const setupPanels = new Map();

/* The closed wire words for the remaining pasted credential. */
const PASTED = {
  OPENCODE: { providerId: "opencode", credentialKind: "opencode_api_key" },
};

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
  return {
    kind,
    cliPath: typeof cliPath === "string" ? cliPath : null,
    foreignStatusLine: pick(value, ["foreign_status_line", "foreignStatusLine"]) === true,
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
  const comparison = compareRuntimeVersions(runtime.version, APP_VERSION);
  return comparison === null || comparison === 0 ? "current" : comparison < 0 ? "older" : "newer";
}

function runtimeInstallCommand(host) {
  return say("runtimeInstall", { host, version: APP_VERSION });
}

/* The terminal installer wires Claude Code's status line only. The prompt hook
   has its own installer, so the setup shows both commands, in this order. */
const CLAUDE_HOOK_INSTALL_COMMAND = `npx -y openlimiter@${APP_VERSION} hooks install claude`;

async function copyCommand(command, note, block) {
  try {
    await window.navigator.clipboard.writeText(command);
    setNote(note, SETUP_EN.copied, "ok");
  } catch {
    const selection = window.getSelection?.();
    if (selection !== null && selection !== undefined && block) {
      const range = document.createRange();
      range.selectNodeContents(block);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setNote(note, SETUP_EN.copyRefused, "bad");
  }
}

function commandBox(command, note) {
  const box = element("div", "q-command-box");
  const block = element("pre", "q-snippet mono", command);
  box.append(block, button(SETUP_EN.copy, () => void copyCommand(command, note, block)));
  return box;
}

/* One line, only when the terminal runtime needs Set up to install or update it. */
function appendRuntimeGuidance(body) {
  const state = runtimeState(session.runtime);
  if (state === "older") body.append(element("p", "q-setup-line", SETUP_EN.runtimeOutdatedVersion.replace("{version}", session.runtime.version)));
  else if (state === "missing") body.append(element("p", "q-setup-line", SETUP_EN.runtimeMissing));
}

/* One numbered step: its words, then whatever it holds, on one left edge. */
function step(text, ...parts) {
  const item = element("li", "q-step");
  item.append(element("p", "q-step-text", text), ...parts);
  return item;
}

function steps(...items) {
  const list = element("ol", "q-steps");
  list.append(...items);
  return list;
}

/* The pasteable commands, folded away under the steps and opened by a failed
   Set up, for a machine where the app cannot run them itself. */
function manualCommands(host, commands, lead) {
  const fold = element("details", "q-setup-alt q-manual");
  fold.dataset.host = host;
  fold.open = session.setupFailed === host;
  fold.append(element("summary", "q-step-text", SETUP_EN.manualHead));
  if (lead) fold.append(element("p", "q-setup-line", lead));
  fold.append(...commands);
  return fold;
}

/* The Set up button: runs the pinned installer through the backend, then
   rereads what it changed. Its running state lives in the session, so the
   panels redrawing every refresh never offer a second press mid run. A
   failure unfolds the commands to run by hand. */
function setUpButton(host, note, after) {
  const busy = session.settingUp === host;
  const control = button(busy ? SETUP_EN.settingUp : SETUP_EN.setUp, async () => {
    if (session.settingUp !== null) return;
    session.settingUp = host;
    session.setupFailed = null;
    setNote(note, "", "plain");
    render();
    const result = await backend.runTerminalSetup(host);
    session.settingUp = null;
    if (result.ok) {
      setNote(note, SETUP_EN.setUpDone, "ok");
      await after();
      render();
      return;
    }
    session.setupFailed = host;
    const sentence = result.reason === backend.BACKEND_ABSENT ? SETUP_EN.noBackend
      : result.message === "setup_unavailable" ? SETUP_EN.setUpNeedsNode
      : result.message === "setup_busy" ? SETUP_EN.setUpBusy
      : SETUP_EN.setUpFailed;
    setNote(note, sentence, "bad");
    render();
  }, "q-btn q-btn-primary");
  control.disabled = session.settingUp !== null;
  if (busy) control.setAttribute("aria-busy", "true");
  return control;
}

/* Claude Code: what Set up does, a warning when the preflight found a status
   line of the person's own, two steps, and the two installer commands folded
   underneath. Every preflight verdict gets the same panel: Set up installs
   the runtime too, so a missing command is something it fixes. */
function renderClaude() {
  const body = document.getElementById("claude-body");
  const note = document.getElementById("claude-note");
  if (!body) return;
  body.textContent = "";
  const verdict = session.claudeVerdict;
  body.append(element("p", "q-setup-lead", SETUP_EN.claudeLead));
  if (verdict?.foreignStatusLine) body.append(element("p", "q-setup-line", SETUP_EN.replacesStatusLine));
  appendRuntimeGuidance(body);
  body.append(
    steps(
      step(SETUP_EN.claudeStepSetUp, setUpButton("claude", note, verifyClaude)),
      step(SETUP_EN.claudeStepVerify, button(SETUP_EN.verify, () => void verifyClaude())),
    ),
    manualCommands("claude", [commandBox(runtimeInstallCommand("claude"), note), commandBox(CLAUDE_HOOK_INSTALL_COMMAND, note)], SETUP_EN.manualClaude),
  );
}

/**
 * The line and update command the Usage tab's Claude card carries while the
 * terminal runtime is older than this app, whose shared request schedule keeps
 * the weekly limits from being read. Null when the runtime is current, newer
 * or not installed.
 */
export function claudeRuntimeNotice() {
  const command = runtimeState(session.runtime) === "older" ? runtimeInstallCommand("claude") : null;
  if (command === null) return null;
  const notice = element("div", "q-runtime-notice");
  const note = element("p", "q-fstatus");
  note.setAttribute("role", "status");
  notice.append(element("p", "q-setup-line", say("claudeRuntimeUpdate")), commandBox(command, note), note);
  return notice;
}

function renderAntigravity() {
  const body = document.getElementById("antigravity-body");
  const note = document.getElementById("antigravity-note");
  if (!body) return;
  body.textContent = "";
  body.append(element("p", "q-setup-lead", SETUP_EN.antigravityLead));
  appendRuntimeGuidance(body);
  body.append(
    steps(
      step(SETUP_EN.antigravityStepSetUp, setUpButton("antigravity", note, async () => { await refreshRuntime(); render(); })),
      step(SETUP_EN.antigravityStepUsage, button(SETUP_EN.checkAgain, () => void checkTool("ANTIGRAVITY"))),
    ),
    manualCommands("antigravity", [commandBox(runtimeInstallCommand("antigravity"), note)]),
  );
}

/* OpenCode connects by itself from the sign in OpenCode saved; this panel is
   for a machine where none works yet: sign in there, or paste a key. */
const OPENCODE_SIGN_IN_COMMAND = "opencode auth login opencode";
const OPENCODE_KEYS_URL = "https://opencode.ai/auth";

/** Whether a detection report holds an OpenCode login OpenLimiter can read. */
export function opencodeSignInFound(report) {
  const entry = Array.isArray(report?.providers)
    ? report.providers.find((provider) => provider?.provider_id === "opencode")
    : null;
  return entry?.state === "present" && Array.isArray(entry.accounts) && entry.accounts.length > 0;
}

function renderOpencode() {
  const body = document.getElementById("opencode-body");
  const note = document.getElementById("opencode-note");
  if (!body) return;
  body.textContent = "";
  const check = button(SETUP_EN.checkAgain, async () => {
    check.disabled = true;
    check.textContent = SETUP_EN.checking;
    /* Found means the native scan now holds an OpenCode login, not merely
       that the scan answered. */
    await checkTool("OPENCODE");
    const found = opencodeSignInFound((await backend.listDetectedProviders()).value);
    check.disabled = false;
    check.textContent = SETUP_EN.checkAgain;
    setNote(note, found ? SETUP_EN.opencodeFound : SETUP_EN.opencodeNotYet, found ? "ok" : "bad");
    if (found) {
      session.activeSetup = null;
      render();
    }
  }, "q-btn q-btn-primary");
  const alt = element("div", "q-setup-alt");
  const head = element("div", "q-setup-alt-head");
  const link = element("a", "q-klink", SETUP_EN.getKey);
  link.setAttribute("href", OPENCODE_KEYS_URL);
  link.setAttribute("target", "_blank");
  link.setAttribute("rel", "noopener noreferrer");
  head.append(element("p", "q-step-text", SETUP_EN.opencodeKeyHead), link);
  const field = element("div", "q-setup-field");
  const input = element("input", "q-kfield");
  Object.assign(input, { type: "password", autocomplete: "off", spellcheck: false, placeholder: SETUP_EN.opencodeKeyField });
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("aria-label", SETUP_EN.opencodeKeyField);
  const save = button(SETUP_EN.save, () => void savePasted("OPENCODE", input, note, save));
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") save.click(); });
  field.append(input, save);
  alt.append(head, field);
  body.append(
    element("p", "q-setup-lead", SETUP_EN.opencodeLead),
    steps(
      step(SETUP_EN.opencodeStepSignIn, commandBox(OPENCODE_SIGN_IN_COMMAND, note)),
      step(SETUP_EN.opencodeStepCheck, check),
    ),
    alt,
  );
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
  renderOpencode();
}

/** Keep each setup panel immediately after the row that opens it. */
export function placeSetupPanels(doc = globalThis.document) {
  if (!doc?.querySelectorAll) return;
  const groups = [...doc.querySelectorAll("#tool-rows [data-provider]")];
  for (const [code, targetId] of Object.entries(SETUP_TARGETS)) {
    const group = groups.find((entry) => entry.getAttribute("data-provider") === code);
    const target = setupPanels.get(targetId) ?? doc.getElementById(targetId);
    const parent = group?.parentElement;
    if (!group || !target || !parent) continue;
    const next = group.nextElementSibling;
    if (target.parentElement === parent && next === target) continue;
    parent.insertBefore(target, next ?? null);
  }
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
    ? { version: typeof runtime.value.version === "string" ? runtime.value.version : null }
    : null;
}

/** Wire the setup panels and the collector event, then read once. */
export function initConnections(configuration) {
  options = configuration;
  session.ready = true;
  for (const code of Object.keys(SETUP_TARGETS)) {
    const panel = document.getElementById(SETUP_TARGETS[code]);
    if (panel) setupPanels.set(SETUP_TARGETS[code], panel);
    panel?.querySelector?.("[data-setup-close]")?.addEventListener("click", () => {
      session.activeSetup = null;
      render();
    });
  }
  /* The runtime is reread too, so the Usage tab's update line leaves once
     the terminal runtime has been updated. */
  void backend.listen(COLLECTOR_UPDATED_EVENT, () => {
    void Promise.all([syncConnections(), refreshRuntime()]).then(() => options.onMetersChanged());
  });
  void bootstrap();
}
