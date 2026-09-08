export const FIRST_RUN_STORAGE_KEY = "openlimiter-first-run-complete-v1";

import {
  configureProvider,
  isProviderConfigured,
  readConfiguredProviders,
  unconfigureProvider,
} from "./configured-providers.js";

/**
 * The launch truth shown before provider setup begins.
 *
 * Both desktop builds ship unsigned on purpose, so the only useful copy on
 * this screen is the exact control a person needs on the operating system
 * they are standing in front of. Windows shows the two SmartScreen actions.
 *
 * macOS now has a release, so the line that used to promise a future one is
 * gone. It went stale the moment the unsigned universal app and dmg were
 * built, and a screen telling someone a download does not exist while they
 * are running that download is worse than a screen saying nothing at all.
 * Gatekeeper refuses an unsigned app on a plain double click and offers no
 * way forward from its dialogue, so the copy names the gesture that works.
 *
 * Linux gets nothing, because nothing stands between the file and running it.
 */
export function launchNotice(platform) {
  const value = String(platform ?? "").toLowerCase();
  if (value.includes("win")) {
    return {
      title: "Unsigned Windows build",
      detail: "SmartScreen: choose More info, then Run anyway.",
    };
  }
  if (value.includes("mac")) {
    return {
      title: "Unsigned macOS build",
      detail:
        "Gatekeeper: control click OpenLimiter in Applications, choose Open, then Open again.",
    };
  }
  return null;
}

function browserPlatform() {
  return navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? "";
}

/**
 * The four ways into an account, and the one that is new.
 *
 * The window owns exactly one sign in body. Three of these ways are drawn by
 * that body and this screen borrows it, so there is still one password field
 * and one email form in the whole document. Microsoft is the only way the
 * body does not already draw, so it is the only button this file makes, and
 * it is placed inside the borrowed body's own provider column rather than in
 * a second stack beside it.
 *
 * The wire value is the name the service knows a provider by, and it is not
 * always the name a person knows. Microsoft is azure on the service side, so
 * the label and the wire value are kept as two separate facts here rather
 * than one string used for both, which is how a rename ends up sending a
 * value no service has ever heard of.
 */
export const SIGN_IN_WAYS = Object.freeze([
  Object.freeze({ id: "github", wire: "github", label: "GitHub", mounted: true }),
  Object.freeze({ id: "google", wire: "google", label: "Google", mounted: true }),
  Object.freeze({ id: "microsoft", wire: "azure", label: "Microsoft", mounted: false }),
  Object.freeze({ id: "email", wire: "email", label: "Email", mounted: true }),
]);

export function signInWay(id) {
  return SIGN_IN_WAYS.find((way) => way.id === id) ?? null;
}

/**
 * Press one way in, through the window's own path.
 *
 * Nothing here knows what a session is. It hands the service the wire value
 * and hands back whatever came, so the one place that owns sign in stays the
 * one place that owns sign in.
 */
export async function pressSignInWay(options, id, pressed = null) {
  const way = signInWay(id);
  if (way === null) return { ok: false, reason: "unknown_way" };
  return options.signInWithProvider(way.wire, pressed);
}

export function signInWayFailureSentence(result, label) {
  const name = typeof label === "string" && label !== "" ? label : "That";
  if (result?.reason === "unconfigured") {
    return name + " sign in is not switched on in this build yet.";
  }
  return name + " sign in could not be completed. Try again.";
}

/*
 * The Microsoft mark, drawn on currentColor.
 *
 * Every other mark in the product is the vendor's own file in the vendor's
 * own colours. Microsoft's four squares are four brand colours, and there is
 * no token for them; a literal hex in this file would be the one colour in
 * the window that no theme and no token sheet can reach. So the geometry is
 * the official four squares and the ink is the control's own, which is the
 * presentation the button beside it already uses for GitHub.
 */
const MICROSOFT_MARK =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" ' +
  'aria-hidden="true" focusable="false">' +
  '<path d="M2 2h9.2v9.2H2Zm10.8 0H22v9.2h-9.2ZM2 12.8h9.2V22H2Zm10.8 0H22V22h-9.2Z"/></svg>';

const USE_CURRENT_LOGIN = "Use my current login";
const SIGN_IN = "Sign in";
const INSTALL = "Install";
const VERIFIED_ON_INSTALL = "Verified on install";
const CONNECTED_REMOVE = "Remove";

/*
 * The one Gemini sentence, on both rows that depend on it.
 *
 * Antigravity reads the same stored Google login the Gemini CLI writes, so
 * it inherits the same fragility and it says so in the same words. Two
 * different sentences for one mechanism is how a person ends up believing
 * one of the two rows is safer than the other.
 */
const GEMINI_DISCLOSURE =
  "Reads the login the Gemini CLI stored, may break when Google changes it";

const CLAUDE_POLL_LABEL = "Poll Anthropic when Claude Code is closed";
const CLAUDE_POLL_NOTE =
  "Off by default. When it is on, OpenLimiter reads your own Claude token to ask Anthropic for your percentage while Claude Code is not running.";

/**
 * The rows of step two, in the order they are drawn.
 *
 * Every row is one provider, one mark, one line of copy and one control. The
 * control is the whole difference between the rows: a detected login is
 * adopted, a Codex login can be created from inside this window, a missing
 * command line tool is named with the line that installs it, and the two
 * tools nobody here can verify say so rather than offering a button that has
 * never been run against the real thing.
 */
export const CONNECT_PROVIDERS = Object.freeze([
  Object.freeze({
    code: "CODEX",
    name: "Codex",
    line: "Reads the Codex login already on this machine.",
    install: "npm install -g @openai/codex",
    installHint: "Run this in your terminal.",
    deviceSignIn: true,
  }),
  Object.freeze({
    code: "CLAUDE",
    name: "Claude Code",
    line: "Reads Claude Code on this machine, and never asks you to sign in.",
    install: "npm install -g @anthropic-ai/claude-code",
    installHint: "Run this in your terminal.",
    neverSignIn: true,
  }),
  Object.freeze({
    code: "GEMINI_CLI",
    name: "Gemini CLI",
    line: GEMINI_DISCLOSURE,
    install: "npm install -g @google/gemini-cli",
    installHint: "Run this in your terminal.",
  }),
  Object.freeze({
    code: "ANTIGRAVITY",
    name: "Antigravity",
    line: GEMINI_DISCLOSURE,
    install: "https://antigravity.google/download",
    installHint: "Open this in your browser.",
  }),
  Object.freeze({
    code: "GROK",
    name: "Grok (xAI)",
    line: "Reads the Grok Build login on this machine.",
    verifiedOnInstall: true,
  }),
  Object.freeze({
    code: "KIMI",
    name: "Kimi",
    line: "Reads the Kimi CLI login on this machine.",
    verifiedOnInstall: true,
  }),
  Object.freeze({
    code: "OPENCODE",
    name: "OpenCode",
    line: "Reads the OpenCode session on this machine.",
    install: "npm install -g opencode-ai",
    installHint: "Run this in your terminal.",
  }),
  Object.freeze({
    code: "OPENROUTER",
    name: "OpenRouter",
    line: "Reads your spend from your own OpenRouter key.",
    keyOnly: true,
  }),
]);

/** Every install line in the product, for the check that they stay technical. */
export const INSTALL_LINES = Object.freeze(
  CONNECT_PROVIDERS.map((provider) => provider.install).filter(
    (line) => typeof line === "string",
  ),
);

const PROVIDERS = CONNECT_PROVIDERS;

const KNOWN_CODES_BY_COMPACT = new Map(
  PROVIDERS.map((provider) => [provider.code.replaceAll("_", ""), provider.code]),
);

function providerCode(value) {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replaceAll("_", "").replaceAll("-", "");
  const alias = {
    XAI: "GROK",
    MOONSHOT: "KIMI",
    MOONSHOTAI: "KIMI",
  }[code] ?? code;
  return KNOWN_CODES_BY_COMPACT.get(alias) ?? null;
}

function detectionState(value) {
  if (value === "present" || value === "installed") return "present";
  if (
    value === "logged_out" ||
    value === "installed_logged_out" ||
    value === "installed_but_logged_out"
  ) {
    return "logged_out";
  }
  return "absent";
}

function stateFor(entry, accounts) {
  const accountStates = accounts.map((account) => detectionState(account?.state));
  if (accountStates.includes("present")) return "present";
  if (accountStates.includes("logged_out")) return "logged_out";
  const declared = detectionState(entry?.state);
  if (
    declared === "present" &&
    accounts.length > 0 &&
    accounts.every((account) => account.auth_state === "stale")
  ) {
    return "logged_out";
  }
  return declared;
}

function recoveryFor(entry, accounts, state) {
  if (state !== "logged_out") return null;
  if (
    entry?.recovery === "reopen_cli" ||
    accounts.some(
      (account) => account.auth_state === "stale" || account.recovery === "reopen_cli",
    )
  ) {
    return "reopen_cli";
  }
  return "sign_in_to_cli";
}

/**
 * Normalize the detection boundary owned by Lane 1.
 *
 * The intended command result is:
 *
 * { providers: [{ provider_id, state, accounts: [{ account_id, auth_state }] }] }
 *
 * Provider is a closed OpenLimiter id. State is present, logged_out or absent.
 * Accounts may contain more than one entry. Account identifiers never leave
 * this function. Only the count reaches the first run screen.
 * XAI and GROK resolve to GROK. MOONSHOT and KIMI resolve to KIMI.
 *
 * The old Claude wiring booleans remain accepted until Lane 1 replaces the
 * command result, so the lanes can land independently without a false crash.
 *
 * Nothing was added to the shape this returns. The Claude status line facts
 * the connect row needs are read straight off the payload by claudeSignals
 * below, because widening every provider entry to carry three booleans that
 * only one provider has ever had is how a normalizer stops being a boundary
 * and starts being a second copy of the payload.
 */
export function normalizeDetections(value) {
  const normalized = new Map(
    PROVIDERS.map((provider) => [
      provider.code,
      { code: provider.code, state: "absent", accountCount: 0, recovery: null },
    ]),
  );

  const entries = Array.isArray(value?.providers) ? value.providers : null;
  if (entries !== null) {
    for (const entry of entries) {
      const code = providerCode(entry?.provider_id ?? entry?.provider);
      if (code === null) continue;
      const accounts = Array.isArray(entry?.accounts)
        ? entry.accounts.filter((account) => account !== null && typeof account === "object")
        : [];
      const state = stateFor(entry, accounts);
      normalized.set(code, {
        code,
        state,
        accountCount: accounts.length,
        recovery: recoveryFor(entry, accounts, state),
      });
    }
    return { available: true, providers: [...normalized.values()] };
  }

  const legacy =
    value !== null &&
    typeof value === "object" &&
    ["claude_settings_present", "statusline_wired", "hook_wired"].some(
      (key) => typeof value[key] === "boolean",
    );
  if (legacy) {
    const present =
      value.claude_settings_present === true ||
      value.statusline_wired === true ||
      value.hook_wired === true;
    normalized.set("CLAUDE", {
      code: "CLAUDE",
      state: present ? "present" : "absent",
      accountCount: 0,
      recovery: null,
    });
    return { available: true, providers: [...normalized.values()] };
  }

  return {
    available: false,
    providers: [...normalized.values()].map((provider) => ({
      ...provider,
      state: "unavailable",
      recovery: null,
    })),
  };
}

/**
 * Serialize detection work and commit only the newest requested generation.
 * A forced scan can arrive while an earlier scan is still reading the machine;
 * it waits in the queue, and an earlier answer can never become committed
 * state after a newer generation has been requested.
 */
export function createDetectionLoader(detectProviders) {
  let generation = 0;
  let committed = null;
  let active = null;
  let queue = Promise.resolve();

  function load(force = false) {
    if (!force && active !== null) return active;
    if (!force && committed !== null) {
      return Promise.resolve({ ...committed, generation });
    }

    const requested = ++generation;
    const task = queue.then(async () => {
      let payload = null;
      try {
        const response = await detectProviders();
        payload = response?.ok === true ? response.value : null;
      } catch {
        payload = null;
      }
      const value = {
        result: normalizeDetections(payload),
        signals: claudeSignals(payload),
        generation: requested,
      };
      if (requested === generation) {
        committed = { result: value.result, signals: value.signals };
      }
      return value;
    });
    queue = task.catch(() => null);
    active = task;
    task.then(
      () => {
        if (active === task) active = null;
      },
      () => {
        if (active === task) active = null;
      },
    );
    return task;
  }

  return Object.freeze({
    load,
    currentGeneration: () => generation,
    isCurrent: (value) => value?.generation === generation,
    committed: () => committed,
  });
}

function readBoolean(source, keys) {
  if (source === null || typeof source !== "object") return false;
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key];
  }
  return false;
}

/**
 * The three Claude facts the connect row is drawn from.
 *
 * Claude Code is read, never signed into, so the only thing its row can say
 * is which of the three shapes the machine is actually in: the status line is
 * already ours, somebody else's status line is in the way and can be wrapped,
 * or neither has happened yet. All three already arrive on the detection
 * payload, in either spelling the backend has used for them.
 */
export function claudeSignals(value) {
  const entries = Array.isArray(value?.providers) ? value.providers : [];
  const entry =
    entries.find(
      (item) => providerCode(item?.provider_id ?? item?.provider) === "CLAUDE",
    ) ??
    (value !== null && typeof value === "object" ? value : null);
  return {
    statuslineWired: readBoolean(entry, ["statusline_wired", "statuslineWired"]),
    foreignStatusLine: readBoolean(entry, ["foreign_status_line", "foreignStatusLine"]),
    wrappableStatusLine:
      readBoolean(entry, ["wrappable_status_line", "wrappableStatusLine"]) ||
      entry?.kind === "wrappable_status_line",
  };
}

/** The one line the Claude row shows, chosen by those three facts. */
export function claudeLine(signals) {
  if (signals?.foreignStatusLine === true || signals?.wrappableStatusLine === true) {
    return "Your own status line is already set, and OpenLimiter can wrap it.";
  }
  if (signals?.statuslineWired === true) {
    return "Reading the status line Claude Code already writes.";
  }
  return "Reads Claude Code on this machine, and never asks you to sign in.";
}

/**
 * The three steps, and the one rule about them.
 *
 * A step is marked done only once it has actually happened. Marking a step
 * complete because it was displayed is how a setup ends up claiming to have
 * done something it never did.
 *
 * The account comes first and it is a real offer, not a wall: the Later link
 * under the buttons goes straight to the tools, and every bar in this window
 * works with no account at all. Connect is where the machine is read. Bars is
 * not a screen, it is the window itself.
 */
export const FIRST_RUN_STEPS = ["account", "connect", "bars"];

export function markStep(root, current) {
  const list = root?.querySelector("#first-run-steps");
  if (list === null || list === undefined) return;
  list.hidden = false;
  const at = FIRST_RUN_STEPS.indexOf(current);
  for (const item of list.querySelectorAll("li")) {
    const index = FIRST_RUN_STEPS.indexOf(item.getAttribute("data-step"));
    item.removeAttribute("aria-current");
    if (index < at) item.setAttribute("data-state", "done");
    else if (index === at) {
      item.setAttribute("data-state", "current");
      item.setAttribute("aria-current", "step");
    } else item.setAttribute("data-state", "todo");
  }
}

/**
 * The Codex device sign in, as a state machine with no window in it.
 *
 * The command line tool prints a code and waits. This window does the same
 * thing without ever raising a console: the backend starts the flow, hands
 * back a code and a page, and this loop asks the backend what happened until
 * it has a terminal answer, the person cancels, or three minutes are gone.
 * A flow that is abandoned is cancelled on the backend as well, so nothing
 * is left waiting on a device code that no one is going to type.
 *
 * Every dependency is passed in. That is what lets the happy path, the
 * cancel and the timeout be checked without a webview, a clock, or the
 * compiled engine anywhere near it.
 */
export const CODEX_SIGN_IN_TIMEOUT_MILLISECONDS = 180_000;
export const CODEX_SIGN_IN_POLL_MILLISECONDS = 2_000;
export const CODEX_DEVICE_LINK_FALLBACK =
  "Open the link Codex printed in the terminal";

export function codexSentence(kind) {
  if (kind === "complete") return "Codex is connected.";
  if (kind === "untrusted_url") return CODEX_DEVICE_LINK_FALLBACK;
  if (kind === "cancelled") return "Sign in cancelled, and nothing changed.";
  if (kind === "timed_out") return "The sign in ran out of time, and nothing changed.";
  return "The sign in did not complete, and nothing changed.";
}

async function cancelQuietly(cancel, sessionId) {
  try {
    await cancel(sessionId);
  } catch (error) {
    /* A backend that cannot be told is still a flow this window has left. */
  }
}

export async function runCodexSignIn(deps) {
  const wait =
    deps.wait ??
    ((milliseconds) =>
      new Promise((resolve) => {
        window.setTimeout(resolve, milliseconds);
      }));
  const now = deps.now ?? (() => Date.now());
  const onStarted = deps.onStarted ?? (() => {});
  const cancelled = deps.cancelled ?? (() => false);

  const started = await deps.start();
  if (started?.ok !== true) {
    const kind = started?.kind === "untrusted_url" ? "untrusted_url" : "failed";
    return { kind: "failed", sentence: codexSentence(kind) };
  }

  const value = started.value ?? {};
  const sessionId = value.sessionId;
  onStarted({
    sessionId,
    userCode: value.userCode ?? "",
    verificationUrl: value.verificationUrl ?? "",
  });

  const began = now();
  for (;;) {
    if (cancelled()) {
      await cancelQuietly(deps.cancel, sessionId);
      return { kind: "cancelled", sentence: codexSentence("cancelled") };
    }
    if (now() - began >= CODEX_SIGN_IN_TIMEOUT_MILLISECONDS) {
      await cancelQuietly(deps.cancel, sessionId);
      return { kind: "timed_out", sentence: codexSentence("timed_out") };
    }
    const answer = await deps.poll(sessionId);
    if (answer?.ok !== true) {
      await cancelQuietly(deps.cancel, sessionId);
      return { kind: "failed", sentence: codexSentence("failed") };
    }
    const kind = answer.value?.kind;
    if (kind === "complete") {
      return {
        kind,
        quota: answer.value?.quota ?? null,
        sentence: codexSentence(kind),
      };
    }
    if (kind === "cancelled" || kind === "timed_out" || kind === "failed") {
      return { kind, sentence: codexSentence(kind) };
    }
    if (kind !== "pending") {
      return { kind: "failed", sentence: codexSentence("failed") };
    }
    await wait(CODEX_SIGN_IN_POLL_MILLISECONDS);
  }
}

/**
 * Which control a connect row offers, and why that one.
 *
 * A detected login is the default everywhere, and it spawns nothing: the
 * window already has what it needs and the press is only a person saying yes
 * to it. Codex is the one tool this release can sign into from here, because
 * it is the one whose device flow has been run against the real service.
 * Grok and Kimi say what is true instead of offering an untested button:
 * neither command line tool is on this machine to verify against. Claude is
 * read and never signed into, so it never gets a sign in control at all.
 */
export function rowAction(provider, detection, signals, quota = null) {
  const state = detection?.state ?? "unavailable";
  if (
    provider.code === "CODEX" &&
    state === "present" &&
    (quota?.kind === "pending" || quota?.kind === "failed") &&
    typeof quota.reason === "string" &&
    quota.reason !== ""
  ) {
    return { kind: "note", note: quota.reason };
  }
  if (state === "present") {
    return { kind: "current", label: USE_CURRENT_LOGIN };
  }
  if (provider.neverSignIn === true) {
    if (state === "absent" && typeof provider.install === "string") {
      return { kind: "install", label: INSTALL, command: provider.install, hint: provider.installHint };
    }
    return { kind: "note", note: claudeLine(signals) };
  }
  if (provider.verifiedOnInstall === true) {
    return { kind: "note", note: VERIFIED_ON_INSTALL };
  }
  if (provider.keyOnly === true) {
    return { kind: "note", note: "Add your OpenRouter key in Connections when you want this bar." };
  }
  if (state === "logged_out" && provider.deviceSignIn === true) {
    return { kind: "signin", label: SIGN_IN };
  }
  if (state === "logged_out") {
    return { kind: "note", note: "Sign in inside the CLI, then reopen OpenLimiter." };
  }
  if (typeof provider.install === "string") {
    return { kind: "install", label: INSTALL, command: provider.install, hint: provider.installHint };
  }
  return { kind: "note", note: "Connect this one in Connections when you want its bar." };
}

/**
 * Every string this module can put in front of a person.
 *
 * It exists so one test can walk the whole vocabulary and prove no dash of
 * any kind reached it. Install lines and the page Antigravity is downloaded
 * from are not prose, they are things a person copies verbatim into a
 * terminal or a browser, so they are the one thing this list leaves out.
 */
export function firstRunCopyStrings() {
  const strings = [
    "Create your account",
    "Later",
    "Connect your tools",
    "Show my bars",
    "Skip",
    "Checking local tools.",
    "Scan complete.",
    "Continue now. Detection can run later.",
    "Detection could not run. Every bar can be connected later.",
    USE_CURRENT_LOGIN,
    SIGN_IN,
    INSTALL,
    VERIFIED_ON_INSTALL,
    CONNECTED_REMOVE,
    "Copied",
    "Copy the line above.",
    "Cancel",
    "Open this page and enter the code.",
    CLAUDE_POLL_LABEL,
    CLAUDE_POLL_NOTE,
    "Run this in your terminal.",
    "Open this in your browser.",
    "Add your OpenRouter key in Connections when you want this bar.",
    "Sign in inside the CLI, then reopen OpenLimiter.",
    "Connect this one in Connections when you want its bar.",
  ];
  strings.push("Use email instead");
  strings.push(CODEX_DEVICE_LINK_FALLBACK);
  for (const way of SIGN_IN_WAYS) {
    strings.push(way.label);
    if (way.id !== "email") strings.push("Continue with " + way.label);
    strings.push(signInWayFailureSentence({ reason: "unconfigured" }, way.label));
    strings.push(signInWayFailureSentence({ reason: "network" }, way.label));
  }
  for (const provider of CONNECT_PROVIDERS) {
    strings.push(provider.name, provider.line);
  }
  for (const signals of [
    { statuslineWired: true },
    { foreignStatusLine: true },
    { wrappableStatusLine: true },
    {},
  ]) {
    strings.push(claudeLine(signals));
  }
  for (const kind of ["complete", "cancelled", "timed_out", "failed", "unknown"]) {
    strings.push(codexSentence(kind));
  }
  for (const platform of ["Win32", "MacIntel", "Linux x86_64"]) {
    const notice = launchNotice(platform);
    if (notice !== null) strings.push(notice.title, notice.detail);
  }
  return strings;
}

/**
 * A build with a function missing degrades rather than throws.
 *
 * Half of these are commands the Rust side is still landing. A window that
 * throws on a missing command is a window with no first run at all, so every
 * one of them has an answer here that is honest about not being wired.
 */
const DEFAULT_OPTIONS = Object.freeze({
  accountStatus: async () => ({ ok: false, reason: "unconfigured" }),
  detectProviders: async () => ({ ok: false, reason: "unconfigured" }),
  markFor: () => "",
  isSignedIn: () => false,
  mountSignIn: () => {},
  unmountSignIn: () => {},
  onAccountState: () => {},
  onContinue: () => {},
  onInstall: () => {},
  signInWithProvider: async () => ({ ok: false, reason: "unconfigured" }),
  codexSignIn: async () => ({ ok: false, reason: "unconfigured" }),
  codexSignInPoll: async () => ({ ok: false, reason: "unconfigured" }),
  codexSignInCancel: async () => ({ ok: true }),
  claudePollEnabled: async () => ({ ok: false, reason: "unconfigured" }),
  setClaudePoll: async () => ({ ok: false, reason: "unconfigured" }),
  copyText: async (text) => {
    await window.navigator.clipboard.writeText(text);
    return { ok: true };
  },
});

function withDefaults(input) {
  const merged = { ...DEFAULT_OPTIONS };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function completeFirstRun(screen) {
  try {
    window.localStorage.setItem(FIRST_RUN_STORAGE_KEY, "complete");
  } catch {
    /* The current session can still continue when storage is unavailable. */
  }
  /* Step three is not a screen. It is the window a person lands in, already
     reading, which is why the last step is marked and then immediately gone
     rather than dwelt on with a congratulation nobody needs. */
  markStep(screen, "bars");
  document.documentElement.dataset.firstRun = "complete";
  screen.hidden = true;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (typeof className === "string") node.className = className;
  if (typeof text === "string") node.textContent = text;
  return node;
}

function quietButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "first-run-quiet-button";
  button.textContent = label;
  return button;
}

/** Keep the old displayed value until the backend confirms the new one. */
export function persistedToggleValue(previous, requested, result) {
  const saved = result === true || (result?.ok === true && result.value === requested);
  return saved ? requested : previous;
}

/*
 * The action lives in the row's own right hand slot and the slot holds its
 * width whatever is in it, so a row that changes state moves nothing beside
 * it. Everything a state needs to say more than a button can hold goes in the
 * disclosure under both columns, which grows the row downward instead.
 */
function connectRow(provider, detection, signals, options, redraw, pollEnabled, quota) {
  const row = element("div", "first-run-row");
  row.dataset.state = detection?.state ?? "unavailable";
  row.dataset.provider = provider.code;

  const identity = element("div", "first-run-identity");
  const mark = element("span", "first-run-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = options.markFor(provider.code);
  const words = element("span", "first-run-identity-copy");
  const name = element("strong", "first-run-name", provider.name);
  const line = element("span", "first-run-subtitle", provider.line);
  words.append(name, line);
  identity.append(mark, words);

  const action = element("div", "first-run-action");
  const disclosure = element("div", "first-run-disclosure");
  disclosure.hidden = true;

  const plan = rowAction(provider, detection, signals, quota);
  action.dataset.kind = plan.kind;
  if (provider.code === "CLAUDE") line.textContent = claudeLine(signals);

  if (plan.kind === "current") {
    const configured = isProviderConfigured(provider.code);
    if (configured) {
      const check = element("span", "first-run-check", "✓");
      check.setAttribute("aria-hidden", "true");
      action.append(check);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "first-run-install";
    button.textContent = configured ? CONNECTED_REMOVE : plan.label;
    button.setAttribute("aria-pressed", configured ? "true" : "false");
    button.setAttribute(
      "aria-label",
      (configured ? CONNECTED_REMOVE : plan.label) + " " + provider.name,
    );
    /* Nothing is spawned here. The login is already on the machine and this
       press is only the person saying yes to reading it. */
    button.addEventListener("click", () => {
      if (isProviderConfigured(provider.code)) unconfigureProvider(provider.code);
      else configureProvider(provider.code);
      redraw();
    });
    action.append(button);
  } else if (plan.kind === "signin") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "first-run-install";
    button.textContent = plan.label;
    button.setAttribute("aria-label", plan.label + " " + provider.name);
    button.addEventListener("click", () => {
      button.disabled = true;
      void startCodexSignIn(provider, options, disclosure, button, redraw);
    });
    action.append(button);
  } else if (plan.kind === "install") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "first-run-install";
    button.textContent = plan.label;
    button.setAttribute("aria-label", plan.label + " " + provider.name);
    disclosure.hidden = false;
    const hint = element("p", "first-run-hint", plan.hint ?? "");
    const command = element("pre", "first-run-command", plan.command);
    command.classList.add("mono");
    const status = element("p", "first-run-hint", "");
    status.setAttribute("role", "status");
    disclosure.append(hint, command, status);
    button.addEventListener("click", () => {
      void (async () => {
        const result = await options.copyText(plan.command).catch(() => ({ ok: false }));
        status.textContent = result?.ok === false ? "Copy the line above." : "Copied";
      })();
    });
    action.append(button);
  } else {
    action.append(element("span", "first-run-note", plan.note));
  }

  row.append(identity, action, disclosure);

  /* The poll setting belongs to the Claude row and to no other, so it is
     drawn under it rather than in a settings list a person has not met yet. */
  if (provider.code === "CLAUDE" && (detection?.state ?? "") === "present") {
    row.append(claudePollRow(options, pollEnabled));
  }
  return row;
}

export function claudePollRow(options, enabled, onPersisted, id = "first-run-claude-poll") {
  const wrapper = element("div", "first-run-poll");
  const label = element("label", "first-run-poll-label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = enabled === true;
  const words = element("span", null, CLAUDE_POLL_LABEL);
  label.append(input, words);
  const note = element("p", "first-run-poll-note", CLAUDE_POLL_NOTE);
  input.addEventListener("change", () => {
    const requested = input.checked === true;
    const previous = !requested;
    input.checked = previous;
    input.disabled = true;
    void options
      .setClaudePoll(requested)
      .catch(() => ({ ok: false }))
      .then((result) => {
        const settled = persistedToggleValue(previous, requested, result);
        input.checked = settled;
        input.disabled = false;
        /* The caller keeps its own copy of the setting, so a row rebuilt
           after this point draws what was actually stored, not the value
           the page started with. */
        if (settled === requested && typeof onPersisted === "function") onPersisted(settled);
      });
  });
  wrapper.append(label, note);
  return wrapper;
}

/*
 * The Codex device flow, drawn inside this window.
 *
 * The code and the page are shown here rather than in a console, because a
 * console window that appears behind the app is a code nobody ever sees. The
 * Cancel control is present from the first frame and stays until the flow has
 * a terminal answer, and every ending that is not a completed sign in puts
 * the row back exactly as it was with one sentence saying what happened.
 */
async function startCodexSignIn(provider, options, disclosure, button, redraw) {
  let cancelled = false;
  disclosure.hidden = false;
  disclosure.textContent = "";

  const lead = element("p", "first-run-hint", "Open this page and enter the code.");
  const url = element("p", "first-run-command", "");
  url.classList.add("mono");
  const code = element("p", "first-run-code", "");
  code.classList.add("mono");
  const status = element("p", "first-run-hint", "");
  status.setAttribute("role", "status");
  const actions = element("div", "first-run-device-actions");
  const cancel = quietButton("Cancel");
  cancel.addEventListener("click", () => {
    cancelled = true;
    cancel.disabled = true;
  });
  actions.append(cancel);
  disclosure.append(lead, url, code, actions, status);

  const outcome = await runCodexSignIn({
    start: () => options.codexSignIn(),
    poll: (sessionId) => options.codexSignInPoll(sessionId),
    cancel: (sessionId) => options.codexSignInCancel(sessionId),
    cancelled: () => cancelled,
    onStarted: (started) => {
      url.textContent = started.verificationUrl;
      code.textContent = started.userCode;
    },
  });

  if (outcome.kind === "complete") {
    configureProvider(provider.code);
    await redraw(outcome.quota);
    return;
  }
  /* Back to where the row was, with one sentence and no dead controls. */
  disclosure.textContent = "";
  disclosure.hidden = false;
  disclosure.append(element("p", "first-run-hint", outcome.sentence));
  button.disabled = false;
}

function renderProviders(screen, result, signals, options, redraw, pollEnabled, quota) {
  const list = screen.querySelector("#first-run-providers");
  const note = screen.querySelector("#first-run-status");
  if (list === null) return;
  const byCode = new Map(result.providers.map((provider) => [provider.code, provider]));
  list.textContent = "";
  for (const provider of PROVIDERS) {
    const detection = byCode.get(provider.code) ?? {
      code: provider.code,
      state: result.available ? "absent" : "unavailable",
      accountCount: 0,
      recovery: null,
    };
    list.append(
      connectRow(provider, detection, signals, options, redraw, pollEnabled, quota),
    );
  }
  if (note === null) return;
  note.textContent = result.available
    ? "Scan complete."
    : "Detection could not run. Every bar can be connected later.";
}

export function initFirstRun(input) {
  const options = withDefaults(input);
  const screen = document.getElementById("first-run");
  if (screen === null) return;

  const setup = screen.querySelector("#first-run-setup");
  const account = screen.querySelector("#first-run-account");

  document.documentElement.dataset.firstRun = "pending";

  let microsoft = null;
  let claudePollEnabled = false;
  let claudePollPromise = null;
  const detections = createDetectionLoader(options.detectProviders);

  function loadClaudePollSetting() {
    if (claudePollPromise !== null) return claudePollPromise;
    claudePollPromise = Promise.resolve()
      .then(async () => {
        const value = typeof options.claudePollEnabled === "function"
          ? await options.claudePollEnabled()
          : options.claudePollEnabled;
        claudePollEnabled = value?.ok === true ? value.value === true : value === true;
      })
      .catch(() => {
        claudePollEnabled = false;
      });
    return claudePollPromise;
  }

  /* Step one. Four ways in, and a plain way past all four.
     The window owns the one sign in body and lends it to this step, so the
     provider buttons and their marks are right here rather than behind a
     second dialog, and there is still exactly one password field in the
     document. Microsoft is the only button this file makes, and it goes into
     the borrowed body's own provider column so the four ways read as one
     stack rather than three and then a stray. */
  function showAccount() {
    screen.setAttribute("aria-labelledby", "first-run-account-title");
    if (setup !== null) setup.hidden = true;
    if (account === null) {
      finish();
      return;
    }
    account.hidden = false;
    markStep(screen, "account");
    /* The step wears the sign in's own centred head, so the panel's lockup
       steps aside for it and the step marks sit on the centre line. */
    screen.dataset.step = "account";
    const mount = screen.querySelector("#first-run-sign-in-mount");
    if (mount !== null) options.mountSignIn(mount);
    addMicrosoft(mount);
  }

  function addMicrosoft(mount) {
    if (mount === null) return;
    const way = signInWay("microsoft");
    if (way === null) return;
    const column = mount.querySelector(".sign-in-providers") ?? mount;
    if (microsoft === null) microsoft = buildMicrosoft(way);
    column.append(microsoft);
  }

  function buildMicrosoft(way) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "first-run-microsoft";
    button.className = "sign-in-provider";
    button.classList.add("first-run-microsoft");
    button.dataset.wire = way.wire;
    const mark = element("span", "sign-in-mark");
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = MICROSOFT_MARK;
    const label = element("span", null, "Continue with " + way.label);
    button.append(mark, label);
    /*
     * The same path the two mounted buttons take, and that is the whole point.
     *
     * This button is the only one this file makes, and an earlier version of
     * it called the service directly. That worked and then stopped: the
     * session arrived, and nothing applied it, nothing drew the arrival and
     * nothing announced it, so a successful Microsoft sign in left first run
     * sitting on step one forever. Every way in now goes through the window's
     * one handler, which owns the account state, the drawn success and the
     * event this screen finishes on.
     *
     * `displayed` is that handler saying it has already written the answer
     * into the shared status line. Writing a second sentence here would put
     * the same refusal on screen twice.
     */
    button.addEventListener("click", () => {
      void (async () => {
        button.disabled = true;
        const result = await pressSignInWay(options, way.id, button).catch(() => ({ ok: false }));
        if (result?.ok === true) return;
        button.disabled = false;
        if (result?.displayed === true) return;
        const status = screen.querySelector("#first-run-way-status");
        if (status !== null) status.textContent = signInWayFailureSentence(result, way.label);
      })();
    });
    return button;
  }

  /* Step two. One row per provider, drawn from what the machine already
     said, with the manual paths as row states rather than as the default. */
  async function showConnect() {
    screen.setAttribute("aria-labelledby", "first-run-title");
    if (account !== null) account.hidden = true;
    if (microsoft !== null) microsoft.remove();
    options.unmountSignIn();
    if (setup === null) {
      finish();
      return;
    }
    setup.hidden = false;
    markStep(screen, "connect");
    screen.dataset.step = "connect";
    const heading = setup.querySelector("#first-run-title");
    heading?.focus({ preventScroll: true });
    const [loaded] = await Promise.all([detections.load(), loadClaudePollSetting()]);
    let codexQuota = null;
    const redraw = async (quota = codexQuota) => {
      const latest = await detections.load(true);
      if (!detections.isCurrent(latest)) return;
      codexQuota = quota;
      renderProviders(
        screen,
        latest.result,
        latest.signals,
        options,
        redraw,
        claudePollEnabled,
        codexQuota,
      );
    };
    const initial = detections.isCurrent(loaded)
      ? loaded
      : await detections.load();
    renderProviders(
      screen,
      initial.result,
      initial.signals,
      options,
      redraw,
      claudePollEnabled,
      codexQuota,
    );
  }

  /* Step three. The bars, which are the window itself. */
  function finish() {
    /* The body goes back to the sheet before this screen is put away, so the
       account menu can raise it again later exactly as it was. */
    if (microsoft !== null) microsoft.remove();
    options.unmountSignIn();
    completeFirstRun(screen);
    options.onContinue();
  }

  const notice = launchNotice(options.platform ?? browserPlatform());
  const noticeElement = screen.querySelector("#first-run-launch-note");
  const noticeTitle = screen.querySelector("#first-run-launch-title");
  const noticeDetail = screen.querySelector("#first-run-launch-detail");
  if (
    notice !== null &&
    noticeElement instanceof HTMLElement &&
    noticeTitle instanceof HTMLElement &&
    noticeDetail instanceof HTMLElement
  ) {
    noticeTitle.textContent = notice.title;
    noticeDetail.textContent = notice.detail;
    screen.dataset.launchNotice = "visible";
    noticeElement.hidden = false;
  }

  screen.querySelector("#first-run-later")?.addEventListener("click", () => {
    void showConnect();
  });
  screen.querySelector("#first-run-skip")?.addEventListener("click", finish);
  screen.querySelector("#first-run-continue")?.addEventListener("click", finish);

  /* The window owns the sign in body, so it tells this screen when a session
     arrived rather than this screen owning a second copy of the form. The
     event is sent once the success state has had its moment on screen, and it
     moves this screen on to the tools rather than ending it: an account is
     step one now, not the last thing asked. */
  window.addEventListener("openlimiter:signed-in", () => {
    if (document.documentElement.dataset.firstRun !== "pending") return;
    if (screen.dataset.step !== "account") return;
    void showConnect();
  });

  void (async () => {
    const result = await options.accountStatus();
    if (result.ok) options.onAccountState(result.value);
    if (
      window.localStorage.getItem(FIRST_RUN_STORAGE_KEY) === "complete" &&
      readConfiguredProviders().length > 0
    ) {
      completeFirstRun(screen);
      return;
    }
    void detections.load();
    /* Somebody already signed in has nothing left to be asked. */
    if (options.isSignedIn()) {
      await showConnect();
      return;
    }
    showAccount();
  })();
}
