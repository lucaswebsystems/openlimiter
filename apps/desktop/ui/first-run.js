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
 * Windows is intentionally shipped without code signing, so the only useful
 * copy is the two SmartScreen controls a person has just used. No unsigned
 * macOS release is offered because Gatekeeper blocks it, including when a
 * developer opens this screen from a local macOS build.
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
      title: "macOS release coming soon",
      detail: "No public download is available yet.",
    };
  }
  return null;
}

function browserPlatform() {
  return navigator.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? "";
}

const PROVIDERS = Object.freeze([
  {
    code: "CODEX",
    name: "Codex",
    subtitle: "Local CLI",
    action: "Connect",
    fallback: "Not found",
  },
  {
    code: "CLAUDE",
    name: "Claude Code",
    subtitle: "Local CLI",
    action: "Connect",
    fallback: "Not found",
  },
  {
    code: "GEMINI_CLI",
    name: "Gemini CLI",
    subtitle: "Local CLI",
    action: null,
    fallback: "Install Gemini CLI",
  },
  {
    code: "ANTIGRAVITY",
    name: "Antigravity",
    subtitle: "Local session",
    action: "Connect",
    fallback: "Not found",
  },
  {
    code: "GROK",
    name: "Grok (xAI)",
    subtitle: "Local detection",
    action: null,
    fallback: "Not found",
  },
  {
    code: "KIMI",
    name: "Kimi",
    subtitle: "Local detection",
    action: null,
    fallback: "Not found",
  },
  {
    code: "OPENCODE",
    name: "OpenCode",
    subtitle: "Browser session",
    action: "Connect",
    fallback: "Not found",
  },
  {
    code: "OPENROUTER",
    name: "OpenRouter",
    subtitle: "API key",
    action: "Connect",
    fallback: "Key needed",
  },
]);

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

function completeFirstRun(screen) {
  try {
    window.localStorage.setItem(FIRST_RUN_STORAGE_KEY, "complete");
  } catch {
    /* The current session can still continue when storage is unavailable. */
  }
  document.documentElement.dataset.firstRun = "complete";
  screen.hidden = true;
}

function statusText(provider, detection, available) {
  if (!available || detection.state === "unavailable") {
    return { state: "unavailable", label: "Check later", detail: "" };
  }
  if (detection.state === "present") {
    return {
      state: "present",
      label: "Installed",
      detail:
        detection.accountCount > 1
          ? String(detection.accountCount) + " accounts"
          : "",
    };
  }
  if (detection.state === "logged_out") {
    return {
      state: "logged_out",
      label: "Installed",
      detail: detection.recovery === "reopen_cli" ? "Reopen the CLI" : "Sign in again",
    };
  }
  return { state: "absent", label: provider.fallback, detail: "" };
}

function providerRow(provider, detection, available, options, screen) {
  const row = document.createElement("div");
  row.className = "first-run-row";
  row.dataset.state = detection.state;
  row.dataset.provider = provider.code;

  const identity = document.createElement("div");
  identity.className = "first-run-identity";
  const mark = document.createElement("span");
  mark.className = "first-run-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = options.markFor(provider.code);
  const words = document.createElement("span");
  words.className = "first-run-identity-copy";
  const name = document.createElement("strong");
  name.className = "first-run-name";
  name.textContent = provider.name;
  const subtitle = document.createElement("span");
  subtitle.className = "first-run-subtitle";
  subtitle.textContent = provider.subtitle;
  words.append(name, subtitle);
  identity.append(mark, words);
  row.append(identity);

  const status = statusText(provider, detection, available);
  if (status.state === "present" || status.state === "logged_out") {
    const fact = document.createElement("span");
    fact.className = "first-run-fact";
    const check = document.createElement("span");
    check.className = "first-run-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = "✓";
    const words = document.createElement("span");
    words.textContent = status.label;
    fact.append(check, words);
    if (status.detail !== "") {
      const detail = document.createElement("span");
      detail.className = "first-run-detail";
      detail.textContent = status.detail;
      fact.append(detail);
    }
    const add = document.createElement("button");
    add.type = "button";
    add.className = "first-run-install";
    const reflect = () => {
      const configured = isProviderConfigured(provider.code);
      add.textContent = configured ? "Remove" : "Add";
      add.setAttribute("aria-pressed", configured ? "true" : "false");
    };
    add.addEventListener("click", () => {
      if (isProviderConfigured(provider.code)) unconfigureProvider(provider.code);
      else configureProvider(provider.code);
      reflect();
    });
    reflect();
    row.append(fact, add);
  } else if (status.state === "absent" && provider.action !== null) {
    const missing = document.createElement("span");
    missing.className = "first-run-missing";
    const caption = document.createElement("span");
    caption.className = "first-run-caption";
    caption.textContent = status.label;
    const install = document.createElement("button");
    install.type = "button";
    install.className = "first-run-install";
    install.textContent = provider.action;
    install.setAttribute("aria-label", provider.action + " " + provider.name);
    install.addEventListener("click", () => {
      configureProvider(provider.code);
      completeFirstRun(screen);
      options.onInstall(provider.code);
    });
    missing.append(caption, install);
    row.append(missing);
  } else {
    const caption = document.createElement("span");
    caption.className = "first-run-caption";
    caption.textContent = status.label;
    row.append(caption);
  }
  return row;
}

function renderProviders(screen, result, options) {
  const list = screen.querySelector("#first-run-providers");
  const note = screen.querySelector("#first-run-status");
  if (list === null || note === null) return;
  const hasDetectedCli = result.providers.some(
    (provider) => provider.code !== "MANUAL" && provider.state !== "absent",
  );
  if (result.available && !hasDetectedCli) {
    screen.dataset.empty = "true";
    const title = screen.querySelector("#first-run-setup h1");
    if (title !== null) title.textContent = "No supported AI CLIs found.";
    list.textContent = "";
    const actions = document.createElement("div");
    actions.className = "first-run-empty-actions";
    const downloads = document.createElement("a");
    downloads.href = "https://openlimiter.com/en/docs/providers";
    downloads.target = "_blank";
    downloads.rel = "noopener noreferrer";
    downloads.className = "first-run-empty-action primary";
    downloads.textContent = "Download CLIs";
    const configure = document.createElement("button");
    configure.type = "button";
    configure.className = "first-run-empty-action";
    configure.textContent = "Configuration";
    configure.addEventListener("click", () => {
      completeFirstRun(screen);
      options.onInstall("CODEX");
    });
    actions.append(downloads, configure);
    list.append(actions);
    downloads.focus();
    return;
  }
  const byCode = new Map(result.providers.map((provider) => [provider.code, provider]));
  list.textContent = "";
  for (const provider of PROVIDERS) {
    const detection = byCode.get(provider.code) ?? {
      code: provider.code,
      state: result.available ? "absent" : "unavailable",
      accountCount: 0,
      recovery: null,
    };
    list.append(providerRow(provider, detection, result.available, options, screen));
  }
  note.textContent = result.available
    ? "Scan complete."
    : "Continue now. Detection can run later.";
}

export function initFirstRun(options) {
  const screen = document.getElementById("first-run");
  if (screen === null) return;

  const gate = screen.querySelector("#account-gate");
  const setup = screen.querySelector("#first-run-setup");
  const gateStatus = screen.querySelector("#account-gate-status");
  const email = screen.querySelector("#account-email");
  const password = screen.querySelector("#account-password");
  const emailForm = screen.querySelector("#account-email-form");
  const createButton = screen.querySelector("#account-email-create");
  const googleButton = screen.querySelector("#account-google");
  const githubButton = screen.querySelector("#account-github");

  document.documentElement.dataset.firstRun = "pending";

  let providersRendered = false;
  async function showSetup() {
    screen.setAttribute("aria-labelledby", "first-run-title");
    gate.hidden = true;
    setup.hidden = false;
    if (providersRendered) return;
    providersRendered = true;
    const response = await options.detectProviders();
    renderProviders(
      screen,
      normalizeDetections(response.ok ? response.value : null),
      options,
    );
  }

  function showAccountFailure(result) {
    if (gateStatus === null) return;
    gateStatus.textContent = result?.message ??
      "Sign in could not be completed. Check your connection and try again.";
  }

  async function runAccount(action) {
    if (gateStatus !== null) gateStatus.textContent = "Opening secure sign in.";
    const result = await action();
    if (!result.ok || result.value?.signedIn !== true) {
      showAccountFailure(result);
      return;
    }
    options.onAccountState(result.value);
    await showSetup();
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

  const continueButton = screen.querySelector("#first-run-continue");
  continueButton?.addEventListener("click", () => {
    completeFirstRun(screen);
    options.onContinue();
  });
  continueButton?.focus();

  emailForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void runAccount(() => options.accountEmail({
      email: email?.value ?? "",
      password: password?.value ?? "",
      create: false,
    }));
  });
  createButton?.addEventListener("click", () => {
    void runAccount(() => options.accountEmail({
      email: email?.value ?? "",
      password: password?.value ?? "",
      create: true,
    }));
  });
  googleButton?.addEventListener("click", () => {
    void runAccount(() => options.accountOauth("google"));
  });
  githubButton?.addEventListener("click", () => {
    void runAccount(() => options.accountOauth("github"));
  });

  void (async () => {
    const result = await options.accountStatus();
    if (!result.ok || result.value?.signedIn !== true) {
      screen.setAttribute("aria-labelledby", "account-gate-title");
      gate.hidden = false;
      setup.hidden = true;
      if (result.ok && result.value?.configured === false && gateStatus !== null) {
        gateStatus.textContent = "Account sign in is not configured in this build.";
      }
      return;
    }
    options.onAccountState(result.value);
    if (
      window.localStorage.getItem(FIRST_RUN_STORAGE_KEY) === "complete" &&
      readConfiguredProviders().length > 0
    ) {
      completeFirstRun(screen);
      return;
    }
    await showSetup();
  })();
}
