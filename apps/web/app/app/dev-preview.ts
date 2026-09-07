import type { Snapshot } from "./engine";

/**
 * Development-only mock snapshots for /app preview mode.
 *
 * This function provides realistic synthetic snapshots covering ALL 9 PROVIDERS
 * across ALL 5 BANDS (Normal, Watch, High, Critical, and Stale/Hatched).
 *
 * Strict safety contract:
 * This module is only consumed when process.env.NODE_ENV !== "production".
 * Production builds dead-code eliminate all preview branches.
 */
export function getDevPreviewSnapshots(now: string): Snapshot[] {
  const nowMs = Date.parse(now);
  const anchor = Number.isFinite(nowMs) ? nowMs : Date.now();
  const ONE_HOUR = 3600 * 1000;
  const FIVE_HOURS = 5 * 3600 * 1000;
  const TWENTY_FOUR_HOURS = 24 * 3600 * 1000;
  const SEVEN_DAYS = 7 * 24 * 3600 * 1000;
  const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

  return [
    // 1. Google Antigravity - Band 4: Critical Depletion (96%, 5h rolling pool, resets in 14m 20s)
    {
      provider: "ANTIGRAVITY",
      meter: "Gemini 2.5 Pro (5h pool)",
      value: 96,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: FIVE_HOURS / 1000 },
      resetAt: new Date(anchor + 14 * 60 * 1000 + 20 * 1000).toISOString(),
      source: "documented_api",
      precision: "exact",
      observedAt: new Date(anchor - 2 * 60 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "primary-work",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    },

    // 2. Gemini CLI - Band 3: High Utilization (84%, 24h quota, resets in 4h 15m)
    {
      provider: "GEMINI_CLI",
      meter: "Daily Quota",
      value: 84,
      unit: "PERCENT",
      window: { kind: "fixed", durationSeconds: TWENTY_FOUR_HOURS / 1000 },
      resetAt: new Date(anchor + 4 * ONE_HOUR + 15 * 60 * 1000).toISOString(),
      source: "documented_api",
      precision: "exact",
      observedAt: new Date(anchor - 3 * 60 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "google-dev",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    },

    // 3. OpenAI Codex - Band 2: Watch Threshold (68%, 5h primary window, resets in 1h 45m)
    {
      provider: "CODEX",
      meter: "Primary Window (5h)",
      value: 68,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: FIVE_HOURS / 1000 },
      resetAt: new Date(anchor + 1 * ONE_HOUR + 45 * 60 * 1000).toISOString(),
      source: "documented_api",
      precision: "exact",
      observedAt: new Date(anchor - 1 * 60 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "openai-main",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    },

    // 4. Claude Code - Band 1: Normal Headroom (24%, 5h rolling window, resets in 3h 20m)
    {
      provider: "CLAUDE",
      meter: "5-Hour Session",
      value: 24,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: FIVE_HOURS / 1000 },
      resetAt: new Date(anchor + 3 * ONE_HOUR + 20 * 60 * 1000).toISOString(),
      source: "documented_api",
      precision: "exact",
      observedAt: new Date(anchor - 30 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "anthropic-claude",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "native-statusline-payload",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "statusline_payload", observedVia: "claude_code_statusline" },
    },

    // 4b. Claude Code, the model scoped weekly window - Band 2: Watch Threshold.
    // A provider is allowed more than one window and the row renderer draws
    // every one of them, so the preview has to carry at least one account with
    // two, or the multi window path is never seen before a release.
    {
      provider: "CLAUDE",
      meter: "Weekly Fable",
      value: 62,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: SEVEN_DAYS / 1000 },
      resetAt: new Date(anchor + 4 * TWENTY_FOUR_HOURS + 6 * ONE_HOUR).toISOString(),
      source: "documented_api",
      precision: "exact",
      observedAt: new Date(anchor - 30 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "anthropic-claude",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "native-statusline-payload",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "statusline_payload", observedVia: "claude_code_statusline" },
    },

    // 5. OpenCode - Band 5: Stale / Disconnected (91%, expired 15m ago -> Hatched Stale Pattern!)
    {
      provider: "OPENCODE",
      meter: "Rolling Usage",
      value: 91,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: TWENTY_FOUR_HOURS / 1000 },
      resetAt: new Date(anchor + 18 * ONE_HOUR).toISOString(),
      source: "authenticated_page",
      precision: "estimated",
      observedAt: new Date(anchor - 45 * 60 * 1000).toISOString(),
      expiresAt: new Date(anchor - 15 * 60 * 1000).toISOString(), // EXPIRED -> Freshness evaluated as "stale"
      accountId: "opencode-team",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "authenticated-scrape",
        automationRisk: "high",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    },

    // 6. OpenRouter - Band 1: Normal Headroom (32% credits usage, $6.40 / $20.00 spent)
    {
      provider: "OPENROUTER",
      meter: "Monthly Credits",
      value: 32,
      unit: "PERCENT",
      window: { kind: "fixed", durationSeconds: THIRTY_DAYS / 1000 },
      resetAt: new Date(anchor + 8 * ONE_HOUR).toISOString(),
      source: "documented_api",
      precision: "exact",
      observedAt: new Date(anchor - 2 * 60 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "router-primary",
      usedAmount: 6.4,
      limitAmount: 20.0,
      currency: "USD",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    },

    // 7. xAI Grok - Band 2: Watch Threshold (74% on-demand tier, resets in 12d)
    {
      provider: "GROK",
      meter: "On-Demand Tier",
      value: 74,
      unit: "PERCENT",
      window: { kind: "fixed", durationSeconds: THIRTY_DAYS / 1000 },
      resetAt: new Date(anchor + 12 * SEVEN_DAYS / 7).toISOString(),
      source: "documented_api",
      precision: "exact",
      observedAt: new Date(anchor - 4 * 60 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "xai-org",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    },

    // 8. Moonshot Kimi - Band 3: High Utilization (86% 5h tier, resets in 2h 10m)
    {
      provider: "KIMI",
      meter: "5-Hour Tier",
      value: 86,
      unit: "PERCENT",
      window: { kind: "rolling", durationSeconds: FIVE_HOURS / 1000 },
      resetAt: new Date(anchor + 2 * ONE_HOUR + 10 * 60 * 1000).toISOString(),
      source: "documented_api",
      precision: "exact",
      observedAt: new Date(anchor - 1 * 60 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "moonshot-dev",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    },

    // 9. Manual Quota - Band 4: Critical Depletion (93% monthly budget, resets in 5d)
    {
      provider: "MANUAL",
      meter: "Monthly Budget",
      value: 93,
      unit: "PERCENT",
      window: { kind: "fixed", durationSeconds: THIRTY_DAYS / 1000 },
      resetAt: new Date(anchor + 5 * 24 * ONE_HOUR).toISOString(),
      source: "manual_entry",
      precision: "manual",
      observedAt: new Date(anchor - 5 * 60 * 1000).toISOString(),
      expiresAt: new Date(anchor + 15 * 60 * 1000).toISOString(),
      accountId: "manual-plan",
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "manual",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "manual_document", observedVia: "user_entry" },
    },
  ];
}
