/**
 * Recorded provider responses for the acquisition path, and the local
 * credential documents that unlock them.
 *
 * Every response body here is either a fixture the connector package already
 * carries, which is the shape a working reader observed against a real account,
 * or a scrubbed document written from the same evidence for a shape that
 * package had no fixture for. Nothing in this file belongs to an account: every
 * token is the same obvious synthetic string, every identifier is invented, and
 * the tests assert against those constants rather than printing anything.
 *
 * No test that uses these opens a socket. The transport is a function that
 * looks a request up in this table, which is the whole point of the closed
 * endpoint table in the core package.
 */
import {
  codexFixture,
  geminiCliFixture,
  grokFixture,
  kimiFixture,
  openrouterFixture
} from "@openlimiter/connectors";

/** A token shaped string that authenticates nothing anywhere. */
export const SYNTHETIC_TOKEN = "synthetic-access-token-0000";

/** The account identifiers the request headers carry, both invented. */
export const SYNTHETIC_CODEX_ACCOUNT = "acct-synthetic-0001";
/** The byte exact main 342f8cc alias for SYNTHETIC_CODEX_ACCOUNT. */
export const SYNTHETIC_CODEX_OPAQUE_ACCOUNT = "codex-bfd7d96c96aa728138c84fa4";
export const SYNTHETIC_GROK_USER = "user-synthetic-0001";

/** The companion project the Code Assist bootstrap answers with. */
export const SYNTHETIC_PROJECT = "managed-project-000";

const FIVE_HOURS = 18_000;
const SEVEN_DAYS = 604_800;

function rfc3339Offset(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1_000).toISOString();
}

/**
 * The Claude account usage document, as the OAuth usage route answers it.
 *
 * Root level windows stating `utilization` and an ISO reset, which is the shape
 * that is NOT the status line payload, plus one model scoped weekly window so
 * the extra keys the plan calls for are actually exercised rather than assumed.
 */
export function claudeUsageResponse(now: string): Record<string, unknown> {
  return {
    five_hour: { utilization: 23.5, resets_at: rfc3339Offset(now, FIVE_HOURS) },
    seven_day: { utilization: 41.2, resets_at: rfc3339Offset(now, SEVEN_DAYS) },
    seven_day_fable: { utilization: 12, resets_at: rfc3339Offset(now, SEVEN_DAYS) }
  };
}

/** The Code Assist bootstrap answer, reduced to the field the next hop needs. */
export function codeAssistLoadResponse(): Record<string, unknown> {
  return {
    cloudaicompanionProject: SYNTHETIC_PROJECT,
    currentTier: { id: "standard-tier" }
  };
}

/**
 * A documented Codex response with both standard windows.
 */
export function codexCountdownResponse(now: string): Record<string, unknown> {
  return {
    accountId: SYNTHETIC_CODEX_OPAQUE_ACCOUNT,
    rateLimits: {
      limitId: "codex",
      primary: {
        usedPercent: 61,
        windowDurationMins: FIVE_HOURS / 60,
        resetsAt: Math.floor(Date.parse(now) / 1_000) + 3_600
      },
      secondary: {
        usedPercent: 22,
        windowDurationMins: SEVEN_DAYS / 60,
        resetsAt: Math.floor(Date.parse(now) / 1_000) + 172_800
      }
    }
  };
}

/** Every recorded response, keyed by the endpoint that answers it. */
export function recordedResponses(now: string): Readonly<Record<string, unknown>> {
  return {
    claude_usage: claudeUsageResponse(now),
    codex_app_server: { ...codexFixture(now), accountId: SYNTHETIC_CODEX_OPAQUE_ACCOUNT },
    code_assist_load: codeAssistLoadResponse(),
    code_assist_quota: geminiCliFixture(now),
    grok_billing: grokFixture(now),
    kimi_usage: kimiFixture(now),
    openrouter_key: openrouterFixture()
  };
}

/** The credential documents each vendor's own client writes on this machine. */
export const credentialDocuments = {
  claude: { claudeAiOauth: { accessToken: SYNTHETIC_TOKEN } },
  codex: {
    tokens: { access_token: SYNTHETIC_TOKEN, account_id: SYNTHETIC_CODEX_ACCOUNT }
  },
  gemini: {
    account_id: "fixture-gemini-account", access_token: SYNTHETIC_TOKEN, token_type: "Bearer" },
  grok: {
    "https://auth.x.ai": {
      access_token: SYNTHETIC_TOKEN,
      user_id: SYNTHETIC_GROK_USER
    }
  },
  kimi: { access_token: SYNTHETIC_TOKEN }
} as const;
