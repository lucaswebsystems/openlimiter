export const FIRST_RUN_STORAGE_KEY = "openlimiter-first-run-complete-v1";
/* "pending" once a fresh first run ends: the window offers the account under
   the first bar, and "dismissed" or "done" settles it for good. */
export const ACCOUNT_OFFER_STORAGE_KEY = "openlimiter-account-offer-v1";

import {
  configureProvider,
  readRemovedProviders,
  readConfiguredProviders,
  homeSelectionControl,
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
 * Gatekeeper refuses an app it has not verified on a plain double click and
 * offers no way forward from its dialogue, and macOS 15 took Open out of the
 * control click menu for it, so the copy names the System Settings path.
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
      title: "macOS preview build",
      detail:
        "Gatekeeper: open OpenLimiter from Applications and choose Done, then in System Settings, Privacy & Security, choose Open Anyway.",
    };
  }
  return null;
}

function browserPlatform() {
  return navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? "";
}

const USE_CURRENT_LOGIN = "Use my current login";
const SIGN_IN = "Sign in";
const TRY_AGAIN = "Try again";

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

/**
 * The rows of the connect step, in the order they are drawn.
 *
 * Every row is one provider, one mark, one line of copy and one control, and
 * a row is drawn only for a tool this machine actually has: a detected login
 * is adopted, a Codex login can be created from inside this window, and a
 * signed out tool says where to sign in. Tools the machine does not have are
 * named in one line under the list rather than asked about one by one.
 */
export const CONNECT_PROVIDERS = Object.freeze([
  Object.freeze({
    code: "CODEX",
    name: "Codex",
    line: "Reads the Codex login already on this machine.",
    deviceSignIn: true,
  }),
  Object.freeze({
    code: "CLAUDE",
    name: "Claude Code",
    line: "Reads Claude Code on this machine, and never asks you to sign in.",
    neverSignIn: true,
  }),
  Object.freeze({ code: "GEMINI_CLI", name: "Gemini CLI", line: GEMINI_DISCLOSURE }),
  Object.freeze({ code: "ANTIGRAVITY", name: "Antigravity", line: GEMINI_DISCLOSURE }),
  Object.freeze({ code: "GROK", name: "Grok (xAI)", line: "Reads the Grok Build login on this machine." }),
  Object.freeze({ code: "KIMI", name: "Kimi", line: "Reads the Kimi CLI login on this machine." }),
  Object.freeze({ code: "OPENCODE", name: "OpenCode", line: "Reads the OpenCode session on this machine." }),
  Object.freeze({
    code: "OPENROUTER",
    name: "OpenRouter",
    line: "Reads your spend from your own OpenRouter key.",
    keyOnly: true,
  }),
]);

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
 * The two steps, and the one rule about them.
 *
 * A step is marked done only once it has actually happened. Marking a step
 * complete because it was displayed is how a setup ends up claiming to have
 * done something it never did.
 *
 * Connect is where the machine is read, and it is the whole first run: the
 * first bar comes before any account, which the window offers under that bar
 * once it lands. Bars is not a screen, it is the window itself.
 */
export const FIRST_RUN_STEPS = ["connect", "bars"];

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

/** "Code expires in 2:59": the time the shown code has left, never below zero. */
export function codexCountdown(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return "Code expires in " + Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
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
 * Every other signed out tool says where its own sign in lives. Claude is
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
    return { kind: "note", note: claudeLine(signals) };
  }
  if (provider.keyOnly === true) {
    return { kind: "note", note: "Add your OpenRouter key under API keys when you want this bar." };
  }
  if (state === "logged_out" && provider.deviceSignIn === true) {
    return { kind: "signin", label: SIGN_IN };
  }
  if (state === "logged_out") {
    return { kind: "note", note: "Sign in inside the CLI, then reopen OpenLimiter." };
  }
  return { kind: "note", note: "Connect this one from Add a tool when you want its bar." };
}

/* A row is drawn only for a tool this machine has, signed in or not. */
function onThisComputer(detection) {
  return detection?.state === "present" || detection?.state === "logged_out";
}

/**
 * The one line that names every tool this machine does not have.
 *
 * A scan that could not run says nothing here: it has not proved anything is
 * absent. OpenRouter is a key rather than a program, so it is never absent
 * from a computer and the API keys list is where it is added.
 */
export function absentLine(result) {
  if (result?.available !== true) return "";
  const byCode = new Map(result.providers.map((provider) => [provider.code, provider]));
  const names = PROVIDERS
    .filter((provider) => provider.keyOnly !== true && byCode.get(provider.code)?.state === "absent")
    .map((provider) => provider.name);
  return names.length === 0
    ? ""
    : "Not on this computer: " + names.join(", ") + ". Add them later in Connect Tools.";
}

/**
 * Every string this module can put in front of a person.
 *
 * It exists so one test can walk the whole vocabulary and prove no dash of
 * any kind reached it.
 */
export function firstRunCopyStrings() {
  const strings = [
    "Connect your tools",
    "Show my bars",
    "Checking local tools.",
    "Scan complete.",
    "Detection could not run. Every bar can be connected later.",
    USE_CURRENT_LOGIN,
    SIGN_IN,
    TRY_AGAIN,
    TRY_AGAIN + ", Codex sign in",
    "Cancel",
    "Open this page and enter the code.",
    "Add your OpenRouter key under API keys when you want this bar.",
    "Sign in inside the CLI, then reopen OpenLimiter.",
    "Connect this one from Add a tool when you want its bar.",
    CODEX_DEVICE_LINK_FALLBACK,
    codexCountdown(CODEX_SIGN_IN_TIMEOUT_MILLISECONDS),
    absentLine(normalizeDetections({ providers: [] })),
  ];
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
  detectProviders: async () => ({ ok: false, reason: "unconfigured" }),
  markFor: () => "",
  onContinue: () => {},
  codexSignIn: async () => ({ ok: false, reason: "unconfigured" }),
  codexSignInPoll: async () => ({ ok: false, reason: "unconfigured" }),
  codexSignInCancel: async () => ({ ok: true }),
  autostartFirstRun: async () => ({ ok: false, reason: "unconfigured" }),
  now: () => Date.now(),
});

function withDefaults(input) {
  const merged = { ...DEFAULT_OPTIONS };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value !== undefined && value !== null) merged[key] = value;
  }
  return merged;
}

function completeFirstRun(screen, options) {
  try {
    window.localStorage.setItem(FIRST_RUN_STORAGE_KEY, "complete");
  } catch {
    /* The current session can still continue when storage is unavailable. */
  }
  /* Rust starts the app at sign in once a first run is complete, so it
     hears about it here: at the end of one, and on every launch after. */
  void Promise.resolve().then(() => options.autostartFirstRun()).catch(() => {});
  /* Bars is not a screen. It is the window a person lands in, already
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

/*
 * The action lives in the right hand slot of its row and the slot holds its
 * width whatever is in it, so a row that changes state moves nothing beside
 * it. Everything a state needs to say more than a button can hold goes in the
 * disclosure under both columns, which grows the row downward instead.
 */
function connectRow(provider, detection, signals, options, redraw, quota) {
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

  if (plan.kind === "current" || readRemovedProviders().includes(provider.code)) {
    action.append(homeSelectionControl(provider.code, () => {}, document, options.setProviderEnabled, provider.name));
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
  } else {
    action.append(element("span", "first-run-note", plan.note));
  }

  row.append(identity, action, disclosure);
  return row;
}

/*
 * The Codex device flow, drawn inside this window.
 *
 * The code and the page are shown here rather than in a console, because a
 * console window that appears behind the app is a code nobody ever sees. The
 * time the code has left counts down under it, quietly: a screen reader hears
 * the ending, not every second. The Cancel control is present from the first
 * frame and stays until the flow has a terminal answer, and every ending that
 * is not a completed sign in puts the row back with one sentence saying what
 * happened and its button offering to try again.
 */
async function startCodexSignIn(provider, options, disclosure, button, redraw) {
  let cancelled = false;
  let ticker = null;
  disclosure.hidden = false;
  disclosure.textContent = "";

  const lead = element("p", "first-run-hint", "Open this page and enter the code.");
  const url = element("p", "first-run-command", "");
  url.classList.add("mono");
  const code = element("p", "first-run-code", "");
  code.classList.add("mono");
  const countdown = element("p", "first-run-countdown", "");
  const status = element("p", "first-run-hint", "");
  status.setAttribute("role", "status");
  const actions = element("div", "first-run-device-actions");
  const cancel = quietButton("Cancel");
  cancel.addEventListener("click", () => {
    cancelled = true;
    cancel.disabled = true;
  });
  actions.append(cancel);
  disclosure.append(lead, url, code, countdown, actions, status);

  const outcome = await runCodexSignIn({
    start: () => options.codexSignIn(),
    poll: (sessionId) => options.codexSignInPoll(sessionId),
    cancel: (sessionId) => options.codexSignInCancel(sessionId),
    cancelled: () => cancelled,
    now: options.now,
    onStarted: (started) => {
      url.textContent = started.verificationUrl;
      code.textContent = started.userCode;
      const ends = options.now() + CODEX_SIGN_IN_TIMEOUT_MILLISECONDS;
      const paint = () => { countdown.textContent = codexCountdown(ends - options.now()); };
      paint();
      ticker = window.setInterval(paint, 1000);
    },
  });
  if (ticker !== null) window.clearInterval(ticker);

  if (outcome.kind === "complete") {
    configureProvider(provider.code);
    await redraw(outcome.quota);
    return;
  }
  /* Back to where the row was, with one sentence and a way to go again. */
  disclosure.textContent = "";
  disclosure.hidden = false;
  disclosure.append(element("p", "first-run-hint", outcome.sentence));
  button.textContent = TRY_AGAIN;
  button.setAttribute("aria-label", TRY_AGAIN + ", " + provider.name + " sign in");
  button.disabled = false;
}

function renderProviders(screen, result, signals, options, redraw, quota) {
  const list = screen.querySelector("#first-run-providers");
  const absent = screen.querySelector("#first-run-absent");
  const note = screen.querySelector("#first-run-status");
  if (list === null) return;
  const byCode = new Map(result.providers.map((provider) => [provider.code, provider]));
  list.textContent = "";
  for (const provider of PROVIDERS) {
    const detection = byCode.get(provider.code);
    if (onThisComputer(detection)) {
      list.append(connectRow(provider, detection, signals, options, redraw, quota));
    }
  }
  /* An empty bordered box is not a list; the line under it says why. */
  list.hidden = list.children.length === 0;
  if (absent !== null) absent.textContent = absentLine(result);
  if (note === null) return;
  note.textContent = result.available
    ? "Scan complete."
    : "Detection could not run. Every bar can be connected later.";
}

function storedFirstRunComplete() {
  try {
    return window.localStorage.getItem(FIRST_RUN_STORAGE_KEY) === "complete";
  } catch {
    return false;
  }
}

/* Offer the account under the first bar, unless the offer was settled. */
function markAccountOffer() {
  try {
    if (window.localStorage.getItem(ACCOUNT_OFFER_STORAGE_KEY) === null) {
      window.localStorage.setItem(ACCOUNT_OFFER_STORAGE_KEY, "pending");
    }
  } catch {
    /* Without storage the offer simply does not appear. */
  }
}

export function initFirstRun(input) {
  const options = withDefaults(input);
  const screen = document.getElementById("first-run");
  if (screen === null) return;

  const setup = screen.querySelector("#first-run-setup");
  const detections = createDetectionLoader(options.detectProviders);

  /* The one step. One row per tool this machine has, drawn from what the
     machine already said, and one line naming the rest. It opens at once,
     saying it checks, and fills itself in when the scan answers. */
  async function showConnect() {
    markStep(screen, "connect");
    if (setup === null) {
      finish();
      return;
    }
    setup.hidden = false;
    setup.querySelector("#first-run-title")?.focus({ preventScroll: true });
    let codexQuota = null;
    const redraw = async (quota = codexQuota) => {
      const latest = await detections.load(true);
      if (!detections.isCurrent(latest)) return;
      codexQuota = quota;
      renderProviders(screen, latest.result, latest.signals, options, redraw, codexQuota);
    };
    const loaded = await detections.load();
    const initial = detections.isCurrent(loaded) ? loaded : await detections.load();
    renderProviders(screen, initial.result, initial.signals, options, redraw, codexQuota);
  }

  /* Show my bars is the only way out, and it asks nothing on the way. */
  function finish() {
    markAccountOffer();
    completeFirstRun(screen, options);
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

  screen.querySelector("#first-run-continue")?.addEventListener("click", finish);

  if (storedFirstRunComplete() && readConfiguredProviders().length > 0) {
    completeFirstRun(screen, options);
    return;
  }
  document.documentElement.dataset.firstRun = "pending";
  void showConnect();
}
