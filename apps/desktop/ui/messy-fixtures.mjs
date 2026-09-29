/*
 * Synthetic readings in the shapes 2.0.1 met on a real machine.
 *
 * Every id, number and instant here is invented. The shapes are not: uppercase
 * provider and meter codes, a status line row with no account id beside a
 * hashed desktop row for the same provider, rows three weeks old, zero valued
 * placeholder rows, a weekly only Codex, an unmeasurable window and an
 * OpenRouter money balance. `raw` is the cache document as a writer leaves it
 * on disk; `projected` is what the native read_cache hands the webview after
 * the data rules ran (displayable rows plus Connections flags). Both are built
 * relative to `now` so a render minutes later still sees fresh rows as fresh.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/* Hash shaped ids, the kind the desktop stamps. None of them is real. */
export const ACCOUNTS = Object.freeze({
  claude: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  claudeBefore: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
  codex: "c0dec0de0123456789abcdef00c0dec0",
  kimi: "4b1d4b1d0123456789abcdef4b1d4b1d",
  antigravity: "a9a9a9a90123456789abcdefb8b8b8b8",
  gemini: "9e9e9e9e0123456789abcdef7d7d7d7d",
  opencode: "0c0c0c0c0123456789abcdef1d1d1d1d",
  openrouter: "0e0e0e0e0123456789abcdef1f1f1f1f",
});

const LOCAL = Object.freeze({
  credentialOrigin: "official-local-tool", dataInterfaceStatus: "internal-endpoint",
  automationRisk: "high", verification: "UNVERIFIED",
});

function row(now, provider, meter, value, options = {}) {
  const { account, age = 2 * MINUTE, reset = null, window = { kind: "rolling", durationSeconds: 7 * 86_400 }, ...rest } = options;
  const observed = now - age;
  return {
    provider, meter, value, unit: "PERCENT", kind: "quota_percent", window,
    resetAt: reset === null ? null : new Date(now + reset).toISOString(),
    source: "internal_payload", precision: "exact",
    observedAt: new Date(observed).toISOString(),
    expiresAt: new Date(observed + 19 * MINUTE).toISOString(),
    labels: LOCAL,
    ...(account === undefined ? {} : { accountId: account }),
    ...rest,
  };
}

/** The whole messy set, as `{ raw, projected, active, sessions }`. */
export function messyFixtures(now = Date.now()) {
  const at = typeof now === "string" ? Date.parse(now) : now;
  const fiveHour = { kind: "rolling", durationSeconds: 18_000 };
  /* Displayable: what the active accounts read in the last few minutes. */
  const shown = [
    row(at, "CLAUDE", "FIVE_HOUR", 6, { account: ACCOUNTS.claude, reset: HOUR + 55 * MINUTE, window: fiveHour, writer: "cli" }),
    row(at, "CLAUDE", "SEVEN_DAY", 46, { account: ACCOUNTS.claude, reset: 4 * DAY + 14 * HOUR, writer: "cli" }),
    row(at, "CLAUDE", "SEVEN_DAY_FABLE", 31, { account: ACCOUNTS.claude, reset: 4 * DAY + 14 * HOUR, writer: "cli" }),
    row(at, "CODEX", "SEVEN_DAY", 70, { account: ACCOUNTS.codex, reset: 4 * DAY, writer: "desktop" }),
    {
      ...row(at, "OPENROUTER", "CREDITS", 25, { account: ACCOUNTS.openrouter, window: { kind: "lifetime" } }),
      source: "documented_api", kind: "money_balance", usedAmount: 12.5, limitAmount: 50, currency: "USD",
      labels: { credentialOrigin: "user-key", dataInterfaceStatus: "documented-api", automationRisk: "low", verification: "UNVERIFIED" },
    },
  ];
  /* Not displayable, each for its own reason. */
  const hidden = [
    // The status line wrote these before it stamped an account id.
    row(at, "CLAUDE", "FIVE_HOUR", 64, { reset: 3 * HOUR, window: fiveHour, age: 3 * MINUTE }),
    row(at, "CODEX", "SEVEN_DAY", 18, { age: MINUTE }),
    // A previous sign in, three weeks old, that nothing will refresh again.
    row(at, "CLAUDE", "FIVE_HOUR", 88, { account: ACCOUNTS.claudeBefore, age: 21 * DAY, window: fiveHour }),
    row(at, "CLAUDE", "SEVEN_DAY", 97, { account: ACCOUNTS.claudeBefore, age: 21 * DAY }),
    row(at, "CODEX", "SEVEN_DAY", 12, { age: 21 * DAY }),
    // Placeholders a failed acquisition leaves behind.
    row(at, "KIMI", "ACQUISITION", 0, { account: ACCOUNTS.kimi, availability: "expired_credentials" }),
    row(at, "ANTIGRAVITY", "ACQUISITION", 0, { account: ACCOUNTS.antigravity, availability: "expired_credentials" }),
    // A window with no measurable meaning.
    row(at, "GEMINI_CLI", "GEMINI_3_1_PRO_PREVIEW", 0, { account: ACCOUNTS.gemini, window: { kind: "unknown" } }),
    // A revoked browser session.
    row(at, "OPENCODE", "SEVEN_DAY", 0, { account: ACCOUNTS.opencode, availability: "access_denied" }),
  ];
  const raw = { version: 2, snapshots: [...hidden, ...shown], suppressions: [] };
  /* Shaped like data_rules::for_app: one flag per provider, account and reason,
     including flags for providers that still have displayable rows. */
  const flags = [
    { provider: "CLAUDE", reason: "account_not_connected", fixKind: "reconnect" },
    { provider: "CLAUDE", accountId: ACCOUNTS.claudeBefore, reason: "account_not_connected", fixKind: "reconnect" },
    { provider: "CODEX", reason: "account_not_connected", fixKind: "reconnect" },
    { provider: "KIMI", accountId: ACCOUNTS.kimi, reason: "expired_credentials", fixKind: "open_app" },
    { provider: "ANTIGRAVITY", accountId: ACCOUNTS.antigravity, reason: "expired_credentials", fixKind: "open_app" },
    { provider: "GEMINI_CLI", accountId: ACCOUNTS.gemini, reason: "placeholder", fixKind: "unsupported" },
    { provider: "OPENCODE", accountId: ACCOUNTS.opencode, reason: "access_denied", fixKind: "reconnect" },
    { provider: "GROK", reason: "missing_credentials", fixKind: "sign_in" },
    { provider: "CURSOR", reason: "disabled", fixKind: "switch_on" },
  ];
  const projected = { version: 2, snapshots: shown, flags };
  const active = new Map([
    ["CLAUDE", new Set([ACCOUNTS.claude])], ["CODEX", new Set([ACCOUNTS.codex])],
    ["KIMI", new Set([ACCOUNTS.kimi])], ["ANTIGRAVITY", new Set([ACCOUNTS.antigravity])],
    ["GEMINI_CLI", new Set([ACCOUNTS.gemini])], ["OPENCODE", new Set([ACCOUNTS.opencode])],
    ["OPENROUTER", new Set([ACCOUNTS.openrouter])],
  ]);
  /* The agents example: one waits for a reply, one works, one finished. */
  const session = (id, agent, state, minutes) => ({
    sessionId: id.repeat(64 / id.length), agent, state, confidence: "explicit",
    observedAt: new Date(at - 5_000).toISOString(), elapsedSeconds: minutes * 60, computer: "local", outcome: null,
  });
  const sessions = [
    session("a1", "claude_code", "waiting", 2),
    session("b2", "codex", "busy", 12),
    session("c3", "gemini_cli", "done", 31),
  ];
  return { raw, projected, active, sessions };
}
