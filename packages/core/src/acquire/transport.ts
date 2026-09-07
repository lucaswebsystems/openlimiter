/**
 * The network layer of the Node acquisition path, closed the same way the
 * desktop's is.
 *
 * There is no function here that fetches a caller supplied URL. There is a
 * closed list of endpoints, each carrying one constant address and one constant
 * method, and a transport that is handed a request built from that list. The
 * whole reachable internet is the table below, and nothing read off disk or out
 * of a provider response can widen it.
 *
 * Failures are a closed vocabulary with no payload, so a header, a body or a
 * token cannot end up inside an error string no matter who formats it. A
 * response outside the success range has its body dropped unread.
 */
import { OPENLIMITER_USER_AGENT } from "./identity.js";

/** One request's total budget, connect to last body byte. */
export const ACQUISITION_TIMEOUT_MILLISECONDS = 15_000;

/** Largest response body accepted, the bound every state file already uses. */
export const MAX_ACQUISITION_RESPONSE_BYTES = 1_048_576;

/* ------------------------------------------------------------- addresses */

/** The Claude account usage report, read with Claude Code's own OAuth token. */
export const CLAUDE_OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** The Codex usage report, read with the session the Codex CLI holds. */
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

/** Gemini CLI's Code Assist account bootstrap, which names the project. */
export const GEMINI_CLI_LOAD_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

/** Gemini CLI's per model quota report. */
export const GEMINI_CLI_QUOTA_URL =
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";

/** The Grok Build billing report the official Grok CLI reads. */
export const GROK_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

/** The Kimi Code usage report the official Kimi CLI reads. */
export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";

/** The OpenRouter inference key report: limit, remaining and usage. */
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";

/**
 * Every address this path may speak to.
 *
 * Adding a provider means adding an entry here, in code, in review. Antigravity
 * has no entry of its own: it reads the same Code Assist pair as Gemini CLI
 * with the credential the Antigravity client stored, which is why this table is
 * shorter than the provider list.
 */
export const ACQUISITION_ENDPOINTS = {
  claude_usage: { url: CLAUDE_OAUTH_USAGE_URL, method: "GET" },
  codex_usage: { url: CODEX_USAGE_URL, method: "GET" },
  code_assist_load: { url: GEMINI_CLI_LOAD_URL, method: "POST" },
  code_assist_quota: { url: GEMINI_CLI_QUOTA_URL, method: "POST" },
  grok_billing: { url: GROK_USAGE_URL, method: "GET" },
  kimi_usage: { url: KIMI_USAGE_URL, method: "GET" },
  openrouter_key: { url: OPENROUTER_KEY_URL, method: "GET" }
} as const satisfies Readonly<Record<string, { url: string; method: "GET" | "POST" }>>;

export type AcquisitionEndpointId = keyof typeof ACQUISITION_ENDPOINTS;

/* ---------------------------------------------------------------- headers */

/** The beta contract the OAuth usage route answers. */
export const CLAUDE_OAUTH_BETA_HEADER = "anthropic-beta";
export const CLAUDE_OAUTH_BETA_VALUE = "oauth-2025-04-20";

/** The account header the ChatGPT backend reads beside the bearer token. */
export const CODEX_ACCOUNT_HEADER = "chatgpt-account-id";

/** The account identity the Grok billing service reads beside the token. */
export const GROK_ACCOUNT_HEADER = "x-userid";

/**
 * The Code Assist bootstrap body, the same metadata the maintained client
 * sends for an account that is already onboarded. Undefined project fields are
 * omitted exactly as that client omits them.
 */
export const CODE_ASSIST_LOAD_BODY = JSON.stringify({
  metadata: {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI"
  }
});

export interface AcquisitionRequest {
  readonly endpoint: AcquisitionEndpointId;
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

/**
 * Whether a secret may be written into a header at all.
 *
 * The value is read off disk from a file this process does not own. A control
 * character in it would let a hostile credential file inject a second header,
 * so anything that is not bounded printable ASCII is refused before it can
 * reach a request. Nothing about the refusal names the value.
 */
export function usableHeaderSecret(value: string): boolean {
  return value.length > 0 &&
    value.length <= 8_192 &&
    /^[\x20-\x7E]+$/u.test(value);
}

/**
 * Whether an account identifier may be written into a header.
 *
 * Narrower than a secret, because this one is an opaque identifier rather than
 * a token: letters, digits and the three separators the observed identifiers
 * use, and nothing else.
 */
export function usableHeaderAccountId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}

function bearer(secret: string): Readonly<Record<string, string>> {
  return {
    authorization: "Bearer " + secret,
    "user-agent": OPENLIMITER_USER_AGENT,
    accept: "application/json"
  };
}

/** The Claude usage request. Our identity, and the documented beta contract. */
export function claudeUsageRequest(secret: string): AcquisitionRequest | null {
  if (!usableHeaderSecret(secret)) return null;
  return {
    endpoint: "claude_usage",
    url: ACQUISITION_ENDPOINTS.claude_usage.url,
    method: "GET",
    headers: { ...bearer(secret), [CLAUDE_OAUTH_BETA_HEADER]: CLAUDE_OAUTH_BETA_VALUE },
    body: null
  };
}

/** The Codex usage request, with the account header the backend requires. */
export function codexUsageRequest(
  secret: string,
  accountId: string
): AcquisitionRequest | null {
  if (!usableHeaderSecret(secret) || !usableHeaderAccountId(accountId)) return null;
  return {
    endpoint: "codex_usage",
    url: ACQUISITION_ENDPOINTS.codex_usage.url,
    method: "GET",
    headers: { ...bearer(secret), [CODEX_ACCOUNT_HEADER]: accountId },
    body: null
  };
}

/** The Code Assist bootstrap, which answers with the companion project. */
export function codeAssistLoadRequest(secret: string): AcquisitionRequest | null {
  if (!usableHeaderSecret(secret)) return null;
  return {
    endpoint: "code_assist_load",
    url: ACQUISITION_ENDPOINTS.code_assist_load.url,
    method: "POST",
    headers: { ...bearer(secret), "content-type": "application/json" },
    body: CODE_ASSIST_LOAD_BODY
  };
}

/**
 * Shape of a companion project identifier, and the reason there is one.
 *
 * The value arrives in a provider response body and is then written into the
 * body of our next request. That is the one place a provider gets to influence
 * what we send, so it is held to an opaque identifier and nothing else.
 */
export const CODE_ASSIST_PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

/** The per model quota request, scoped to a validated companion project. */
export function codeAssistQuotaRequest(
  secret: string,
  project: string
): AcquisitionRequest | null {
  if (!usableHeaderSecret(secret)) return null;
  if (!CODE_ASSIST_PROJECT_PATTERN.test(project)) return null;
  return {
    endpoint: "code_assist_quota",
    url: ACQUISITION_ENDPOINTS.code_assist_quota.url,
    method: "POST",
    headers: { ...bearer(secret), "content-type": "application/json" },
    body: JSON.stringify({ project, userAgent: OPENLIMITER_USER_AGENT })
  };
}

/**
 * The Grok billing request.
 *
 * The account header is an identifier for the person's own account and is sent
 * when the credential names one. Nothing else is: the desktop sends xAI's
 * `x-xai-token-auth: xai-grok-cli` marker beside it, and that value NAMES THE
 * VENDOR'S OWN TOOL, which is the same claim a copied user agent makes. Rule 1
 * says we identify as OpenLimiter and take whatever that costs us, so the
 * marker is not sent here and no client version is invented either.
 *
 * The consequence is honestly unknown rather than assumed: no Grok login exists
 * on the machine this was written on, so whether the billing route answers a
 * request that does not claim to be the Grok CLI is verified on the first
 * install that has one, and the row says so until then.
 */
export function grokBillingRequest(
  secret: string,
  accountId: string | null
): AcquisitionRequest | null {
  if (!usableHeaderSecret(secret)) return null;
  const account = accountId !== null && usableHeaderAccountId(accountId)
    ? accountId
    : null;
  return {
    endpoint: "grok_billing",
    url: ACQUISITION_ENDPOINTS.grok_billing.url,
    method: "GET",
    headers: {
      ...bearer(secret),
      ...(account === null ? {} : { [GROK_ACCOUNT_HEADER]: account })
    },
    body: null
  };
}

/** The Kimi Code usage request. */
export function kimiUsageRequest(secret: string): AcquisitionRequest | null {
  if (!usableHeaderSecret(secret)) return null;
  return {
    endpoint: "kimi_usage",
    url: ACQUISITION_ENDPOINTS.kimi_usage.url,
    method: "GET",
    headers: bearer(secret),
    body: null
  };
}

/** The OpenRouter key report, the one documented interface in this table. */
export function openrouterKeyRequest(secret: string): AcquisitionRequest | null {
  if (!usableHeaderSecret(secret)) return null;
  return {
    endpoint: "openrouter_key",
    url: ACQUISITION_ENDPOINTS.openrouter_key.url,
    method: "GET",
    headers: bearer(secret),
    body: null
  };
}

/* -------------------------------------------------------------- outcomes */

/**
 * What one request achieved, in words this product owns.
 *
 * Every value here is a decision about what to do next, never a description of
 * a response body. `blocked` and `rate_limited` are separated because they earn
 * different backoffs, and `drift` is separated from `remote_error` because only
 * drift says the meaning of a stored reading is in doubt.
 *
 * `identity_refused` is the one that cost the most to learn. A provider can
 * answer 200 to an honest client and still leave out the field the next request
 * needs, which reads exactly like drift and is not: nothing changed shape, the
 * provider simply serves that field to its own tools. Measured on 2026-09-07
 * against Code Assist, which answered 200 with tier information and no
 * companion project. Calling it drift would have had this build retry every
 * fifteen minutes forever against an answer that will never differ.
 */
export const ACQUISITION_OUTCOMES = [
  "ok",
  "unauthorized",
  "rate_limited",
  "blocked",
  "remote_error",
  "transport",
  "too_large",
  "drift",
  "identity_refused"
] as const;

export type AcquisitionOutcome = (typeof ACQUISITION_OUTCOMES)[number];

export interface AcquisitionReply {
  readonly status: number;
  readonly body: string;
  /** Retry-After in seconds when the provider stated one, otherwise null. */
  readonly retryAfterSeconds: number | null;
}

export type AcquisitionTransport = (
  request: AcquisitionRequest
) => Promise<AcquisitionReply>;

/**
 * Turn a status into a decision.
 *
 * 401 and 403 are told apart on purpose. A lapsed token is a person's next
 * step, and a refusal to serve this client at all is a reason to stay away for
 * a day. Everything from 500 up is the provider having a bad minute and is
 * retried on the ordinary interval.
 */
export function outcomeForStatus(status: number): AcquisitionOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "unauthorized";
  if (status === 403) return "blocked";
  if (status === 429) return "rate_limited";
  return "remote_error";
}

/** Retry-After in seconds, when the header is a count of seconds we believe. */
export function retryAfterSeconds(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d{1,7}$/u.test(trimmed)) return null;
  const seconds = Number.parseInt(trimmed, 10);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * The header names an acquisition request may carry.
 *
 * Closed, and checked at the boundary below rather than trusted from the
 * builders above. The builders are the only callers today, but the transport is
 * exported and a future caller that assembled a request by hand would otherwise
 * be able to put anything on the wire under this product's name.
 */
export const ALLOWED_REQUEST_HEADERS: readonly string[] = [
  "authorization",
  "accept",
  "user-agent",
  "content-type",
  CLAUDE_OAUTH_BETA_HEADER,
  CODEX_ACCOUNT_HEADER,
  GROK_ACCOUNT_HEADER
];

/**
 * Whether one header's VALUE is the value that header is allowed to hold.
 *
 * Checking names alone was half a check. A name allowlist stops a cookie going
 * out; it does nothing about an authorization header carrying something that is
 * not a bearer token, or a beta header carrying a contract we never agreed to,
 * or an account header carrying a path. Each of these has exactly one shape and
 * this is where each one is held to it.
 */
function validHeaderValue(name: string, value: string, method: string): boolean {
  if (!/^[\x20-\x7E]+$/u.test(value)) return false;
  if (name === "user-agent") return value === OPENLIMITER_USER_AGENT;
  if (name === "accept") return value === "application/json";
  if (name === "content-type") {
    return value === "application/json" && method === "POST";
  }
  if (name === "authorization") {
    return value.startsWith("Bearer ") && usableHeaderSecret(value.slice(7));
  }
  if (name === CLAUDE_OAUTH_BETA_HEADER) return value === CLAUDE_OAUTH_BETA_VALUE;
  if (name === CODEX_ACCOUNT_HEADER || name === GROK_ACCOUNT_HEADER) {
    return usableHeaderAccountId(value);
  }
  return false;
}

/**
 * Whether a request body is the body that endpoint is allowed to carry.
 *
 * Two endpoints take a body and both bodies have a fixed shape. The bootstrap's
 * is a constant. The quota read's carries the one field a provider response
 * ever influences, which is exactly why it is checked here rather than trusted
 * from the builder: this is the last point before the wire, and the last chance
 * to notice that a project identifier grew into something else.
 */
function validRequestBody(request: AcquisitionRequest): boolean {
  if (request.endpoint === "code_assist_load") {
    return request.body === CODE_ASSIST_LOAD_BODY;
  }
  if (request.endpoint === "code_assist_quota") {
    if (request.body === null) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body) as unknown;
    } catch {
      return false;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const fields = parsed as Record<string, unknown>;
    const keys = Object.keys(fields).sort();
    if (keys.length !== 2 || keys[0] !== "project" || keys[1] !== "userAgent") {
      return false;
    }
    const project = fields["project"];
    return typeof project === "string" &&
      CODE_ASSIST_PROJECT_PATTERN.test(project) &&
      fields["userAgent"] === OPENLIMITER_USER_AGENT;
  }
  /* Every other endpoint is a GET that asks for something and sends nothing. */
  return request.body === null && request.method === "GET";
}

/**
 * Whether a request may leave this process.
 *
 * Address, method, every header name, every header VALUE and the body, all
 * answered against constants in this file. A request that fails any of them
 * never reaches the network.
 */
export function validAcquisitionRequest(request: AcquisitionRequest): boolean {
  const endpoint = ACQUISITION_ENDPOINTS[request.endpoint];
  if (endpoint === undefined) return false;
  if (request.url !== endpoint.url || request.method !== endpoint.method) return false;
  if (request.headers["user-agent"] !== OPENLIMITER_USER_AGENT) return false;
  for (const name of Object.keys(request.headers)) {
    if (!ALLOWED_REQUEST_HEADERS.includes(name)) return false;
    const value = request.headers[name];
    if (value === undefined) return false;
    if (!validHeaderValue(name, value, request.method)) return false;
  }
  return validRequestBody(request);
}

/**
 * The transport the product uses, built on the runtime's own fetch.
 *
 * Redirects are refused rather than followed: a redirect on any of these
 * addresses would carry the bearer token somewhere the closed table above never
 * named. The body is bounded before it is decoded, and the whole request lives
 * under one deadline. A transport level failure is an exception, which the
 * runner turns into the `transport` outcome without ever formatting it.
 */
export function createFetchTransport(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch
): AcquisitionTransport {
  return async (request) => {
    /* Payload free on purpose. The runner turns this into the `transport`
       outcome, and an error carrying a URL or a header would be the one place
       a credential could reach a log. */
    if (!validAcquisitionRequest(request)) {
      throw new Error("Refused a request outside the acquisition contract");
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      ACQUISITION_TIMEOUT_MILLISECONDS
    );
    try {
      const response = await fetchImplementation(request.url, {
        method: request.method,
        headers: { ...request.headers },
        redirect: "error",
        signal: controller.signal,
        ...(request.body === null ? {} : { body: request.body })
      });
      const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
      if (response.status < 200 || response.status >= 300) {
        /* The body of a refusal is never read. It cannot help, and reading it
           is how a provider's prose reaches a log. */
        return { status: response.status, body: "", retryAfterSeconds: retryAfter };
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_ACQUISITION_RESPONSE_BYTES) {
        /* Status zero is this layer's way of saying the answer was refused
           before it was read, which the runner reads as too large. */
        return { status: 0, body: "", retryAfterSeconds: retryAfter };
      }
      return {
        status: response.status,
        body: new TextDecoder("utf-8", { fatal: false }).decode(buffer),
        retryAfterSeconds: retryAfter
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
