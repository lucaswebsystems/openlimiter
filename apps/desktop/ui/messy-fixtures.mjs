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
      ...row(at, "OPENROUTER", "ACCOUNT_BALANCE", 25, { account: ACCOUNTS.openrouter, window: { kind: "lifetime" } }),
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

/** Nothing connected yet: no displayable row and nothing flagged. */
export function emptyFixtures() {
  return { raw: { version: 2, snapshots: [], suppressions: [] }, projected: { version: 2, snapshots: [], flags: [] }, sessions: [] };
}

/*
 * The one screen's four review states, each as everything the native side
 * answers with: the cache, the detection report, the connection records, the
 * API spend status and Claude Code's setup. Ids and amounts are invented.
 */
export function screenFixtures(now = Date.now()) {
  const at = typeof now === "string" ? Date.parse(now) : now;
  const iso = (offset) => new Date(at + offset).toISOString();
  const month = iso(0).slice(0, 8) + "01";
  const previous = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  const { projected, sessions } = messyFixtures(at);
  const fiveHour = { kind: "rolling", durationSeconds: 18_000 };
  const unwired = { claude_settings_present: true, statusline_wired: false };
  const wired = { claude_settings_present: true, statusline_wired: true };
  const ready = { kind: "ready", cli_path: "openlimiter" };
  const source = (id, provider, status = "eligible", keyLabel = provider) => ({
    id, provider, keyLabel, lastFour: "a1b2", enabled: true, consentVersion: 2, teamId: provider === "xai" ? "team-demo" : null,
    budgetUsd: null, lastObservedAt: iso(-3 * MINUTE), nextAllowedAt: 0, status,
    metricKind: provider === "moonshot" || provider === "deepseek" ? "balance" : "spend",
  });
  const sample = (sourceId, provider, displayState, overrides = {}) => ({
    id: "s-" + sourceId, sourceId, provider, keyLabel: provider,
    metricKind: provider === "moonshot" || provider === "deepseek" ? "balance" : "spend",
    month, displayState, observedAt: iso(-3 * MINUTE), sourcePeriod: "", forecastDate: null,
    completeness: provider === "moonshot" || provider === "deepseek" ? "current_balance" : "complete", ...overrides,
  });
  const ids = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;
  const empty = {
    cache: { version: 2, snapshots: [], flags: [] }, detections: { providers: [] }, connections: [],
    spend: { version: 1, localDisplayIsFree: true, sources: [], samples: [] }, claude: { claude_settings_present: false }, preflight: ready, sessions: [],
  };
  const codex = projected.snapshots.filter((row) => row.provider === "CODEX");
  const waiting = {
    cache: { version: 2, snapshots: codex, flags: [{ provider: "CLAUDE", reason: "awaiting_statusline", fixKind: "open_app" }] },
    detections: { providers: [{ provider_id: "codex", state: "present", accounts: [] }, { provider_id: "claude", state: "present", accounts: [] }], antigravity_running: false },
    connections: [], spend: empty.spend, claude: wired, preflight: ready, sessions: [],
  };
  const antigravity = [
    row(at, "ANTIGRAVITY", "GEMINI_3_PRO", 38, { account: ACCOUNTS.antigravity, reset: 3 * HOUR, window: fiveHour, writer: "desktop" }),
    row(at, "ANTIGRAVITY", "CLAUDE_SONNET", 12, { account: ACCOUNTS.antigravity, reset: 3 * HOUR, window: fiveHour, writer: "desktop" }),
  ];
  const money = {
    cache: { version: 2, snapshots: [...projected.snapshots, ...antigravity], flags: [] },
    detections: { providers: ["codex", "claude", "antigravity"].map((id) => ({ provider_id: id, state: "present", accounts: [] })), antigravity_running: true },
    connections: [{ id: "c-openrouter", provider_id: "openrouter", status: "CONNECTED", account_alias: "default" }],
    spend: { version: 1, localDisplayIsFree: true, sources: [
      source(ids(1), "openai"), source(ids(2), "anthropic"), source(ids(3), "xai"), source(ids(4), "moonshot"), source(ids(5), "deepseek"),
    ], samples: [
      sample(ids(1), "openai", { kind: "tracked", amountUsd: "84.17", percentOfBudget: null }),
      sample(ids(2), "anthropic", { kind: "tracked", amountUsd: "212.40", percentOfBudget: null }, { month: previous }),
      sample(ids(3), "xai", { kind: "tracked", amountUsd: "9.03", percentOfBudget: null }, { completeness: "period_incomplete" }),
      sample(ids(4), "moonshot", { kind: "balance", amountUsd: "41.5" }),
      sample(ids(5), "deepseek", { kind: "balance", amountUsd: "18.2" }),
    ] },
    claude: wired, preflight: ready, sessions,
  };
  const errors = {
    cache: { version: 2, snapshots: codex, flags: [
      { provider: "CLAUDE", reason: "account_unresolved", fixKind: "sign_in" },
      { provider: "GROK", reason: "missing_credentials", fixKind: "sign_in" },
      { provider: "GEMINI_CLI", reason: "placeholder", fixKind: "unsupported" },
      { provider: "KIMI", reason: "expired_credentials", fixKind: "open_app" },
    ] },
    detections: { providers: [{ provider_id: "claude", state: "present", accounts: [] }], antigravity_running: false },
    connections: [{ id: "c-openrouter", provider_id: "openrouter", status: "NEEDS_AUTH", account_alias: "default" }],
    spend: { version: 1, localDisplayIsFree: true, sources: [
      source(ids(1), "openai", "ineligible_or_revoked"), source(ids(2), "anthropic", "temporarily_unavailable"),
      source(ids(3), "xai", "pending_validation"), source(ids(4), "moonshot", "too_low_for_api_calls"), source(ids(5), "deepseek"),
    ], samples: [
      sample(ids(2), "anthropic", { kind: "tracked", amountUsd: "57.80", percentOfBudget: null }),
      sample(ids(4), "moonshot", { kind: "balance", amountUsd: "0.62" }),
      sample(ids(5), "deepseek", { kind: "reportedInCny" }),
    ] },
    claude: wired, preflight: ready, sessions: [],
  };
  return { empty, waiting, money, errors };
}

/* Enough measured tools and windows to fill the panel past its clamp at 90%
   of the screen, with agents on top. */
export function tallFixtures(now = Date.now()) {
  const at = typeof now === "string" ? Date.parse(now) : now;
  const { sessions } = messyFixtures(at);
  const rows = [
    ["CLAUDE", "FIVE_HOUR", 91, HOUR], ["CLAUDE", "SEVEN_DAY", 64, 3 * DAY], ["CLAUDE", "SEVEN_DAY_FABLE", 40, 3 * DAY],
    ["CODEX", "SEVEN_DAY", 83, 2 * DAY], ["CODEX", "PRIMARY", 22, 3 * HOUR],
    ["GEMINI_CLI", "GEMINI_3_1_PRO_PREVIEW", 55, 12 * HOUR], ["GEMINI_CLI", "GEMINI_3_FLASH_PREVIEW", 18, 12 * HOUR],
    ["GROK", "WEEKLY", 71, 5 * DAY], ["GROK", "ON_DEMAND_MONTHLY", 9, 20 * DAY],
    ["KIMI", "WEEKLY", 36, 6 * DAY], ["KIMI", "FIVE_HOUR", 12, 2 * HOUR],
    ["CURSOR", "INCLUDED", 48, 18 * DAY], ["CURSOR", "AUTO", 27, 18 * DAY], ["CURSOR", "API", 5, 18 * DAY],
    ["OPENCODE", "FIVE_HOUR", 30, 4 * HOUR], ["OPENCODE", "SEVEN_DAY", 21, 4 * DAY], ["OPENCODE", "MONTHLY", 14, 25 * DAY],
  ].map(([provider, meter, value, reset]) => row(at, provider, meter, value, { reset, writer: "cli" }));
  return { projected: { version: 2, snapshots: rows, flags: [] }, sessions };
}
