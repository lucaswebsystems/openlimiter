export const FIRST_RUN_STORAGE_KEY = "openlimiter-first-run-complete-v1";

const PROVIDERS = Object.freeze([
  {
    code: "CLAUDE",
    name: "Claude Code",
    install: true,
    fallback: "Manual setup",
  },
  {
    code: "CODEX",
    name: "Codex",
    install: true,
    fallback: "Manual setup",
  },
  {
    code: "ANTIGRAVITY",
    name: "Antigravity",
    install: true,
    fallback: "Manual setup",
  },
  {
    code: "GEMINI_CLI",
    name: "Gemini CLI",
    install: false,
    fallback: "Install Gemini CLI",
  },
  {
    code: "OPENCODE",
    name: "OpenCode",
    install: true,
    fallback: "Manual setup",
  },
  {
    code: "OPENROUTER",
    name: "OpenRouter",
    install: false,
    fallback: "Add your API key later",
  },
  {
    code: "MANUAL",
    name: "Manual",
    install: false,
    fallback: "Add a manual reading later",
  },
]);

const KNOWN_CODES_BY_COMPACT = new Map(
  PROVIDERS.map((provider) => [provider.code.replaceAll("_", ""), provider.code]),
);

function providerCode(value) {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replaceAll("_", "").replaceAll("-", "");
  return KNOWN_CODES_BY_COMPACT.get(code) ?? null;
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
    return { state: "unavailable", label: "Detection unavailable", detail: "" };
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

  const identity = document.createElement("div");
  identity.className = "first-run-identity";
  const mark = document.createElement("span");
  mark.className = "first-run-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.innerHTML = options.markFor(provider.code);
  const name = document.createElement("span");
  name.className = "first-run-name";
  name.textContent = provider.name;
  identity.append(mark, name);
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
    row.append(fact);
  } else if (status.state === "absent" && provider.install) {
    const install = document.createElement("button");
    install.type = "button";
    install.className = "first-run-install";
    install.textContent = "Install";
    install.setAttribute("aria-label", "Install " + provider.name);
    install.addEventListener("click", () => {
      completeFirstRun(screen);
      options.onInstall(provider.code);
    });
    row.append(install);
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
    ? "Local check complete."
    : "Local detection is not available in this build. You can still continue.";
}

export function initFirstRun(options) {
  const screen = document.getElementById("first-run");
  if (screen === null || document.documentElement.dataset.firstRun === "complete") {
    return;
  }

  const continueButton = screen.querySelector("#first-run-continue");
  continueButton?.addEventListener("click", () => {
    completeFirstRun(screen);
    options.onContinue();
  });
  continueButton?.focus();

  void (async () => {
    const response = await options.detectProviders();
    renderProviders(
      screen,
      normalizeDetections(response.ok ? response.value : null),
      options,
    );
  })();
}
