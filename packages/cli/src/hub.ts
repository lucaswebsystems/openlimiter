/**
 * The one hosted surface the CLI ever talks to: OpenLimiter's own hub.
 *
 * Closed the same way the acquisition transport in the core package is closed:
 * one function per endpoint, a fixed method and a fixed shape, and a transport
 * that is handed a request built from that list rather than a caller supplied
 * URL. Nothing here reaches a provider's own API; that is the acquisition
 * path's job. This is the sign in, the token renewal and the sync upload, and
 * nothing else.
 *
 * The hub's address is a public project reference, not a secret, and travels
 * as a constant. The anon key is a Supabase publishable key, which is meant to
 * ship inside a client, but this build was not handed a literal value for it,
 * so it is read from the environment at run time. A build with no key
 * configured answers every hub command with "not configured" rather than
 * sending a request with an empty credential.
 */
import { OPENLIMITER_USER_AGENT } from "@openlimiter/core";

/** The project this build talks to, absent a build time override. */
export const DEFAULT_HUB_URL = "https://dsaonzonizvxtxgclwud.supabase.co";

/** The hub's publishable key: public by design, shipped in every client, overridable through OPENLIMITER_SUPABASE_ANON_KEY. */
export const DEFAULT_HUB_PUBLISHABLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRzYW9uem9uaXp2eHR4Z2Nsd3VkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczMzQ2NjUsImV4cCI6MjEwMjkxMDY2NX0._HoDeczRScWuN5B_xXUlPFfxGbGj6Je3UodVgVsXjQA";

/** One request's total budget, connect to last body byte. */
export const HUB_TIMEOUT_MILLISECONDS = 15_000;

/** Largest response body accepted before this build stops reading it. */
export const MAX_HUB_RESPONSE_BYTES = 1_048_576;

/** Largest request body this build will ever send to the hub. */
export const MAX_HUB_REQUEST_BYTES = 131_072;

function envValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string
): string {
  const value = environment[key];
  return value === undefined ? "" : value;
}

/** The hub's base address, overridable for a non production build or a test. */
export function hubBaseUrl(environment: Readonly<Record<string, string | undefined>>): string {
  const configured = envValue(environment, "OPENLIMITER_SUPABASE_URL");
  return configured === "" ? DEFAULT_HUB_URL : configured;
}

/** The publishable key: the environment override when set, otherwise the shipped default. */
export function hubAnonKey(environment: Readonly<Record<string, string | undefined>>): string {
  const configured = envValue(environment, "OPENLIMITER_SUPABASE_ANON_KEY");
  return configured === "" ? DEFAULT_HUB_PUBLISHABLE_KEY : configured;
}

/** Whether the hub has enough configuration to be asked anything at all. */
export function hubConfigured(environment: Readonly<Record<string, string | undefined>>): boolean {
  return hubAnonKey(environment).length > 0;
}

export type HubEndpointId = "cli_login" | "grant_renew" | "sync_snapshots";

const HUB_FUNCTION_PATHS: Readonly<Record<HubEndpointId, string>> = {
  cli_login: "/functions/v1/cli-login",
  grant_renew: "/functions/v1/pro-service",
  sync_snapshots: "/functions/v1/sync-snapshots"
};

export interface HubRequest {
  readonly endpoint: HubEndpointId;
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HubReply {
  readonly status: number;
  readonly body: string;
}

export type HubTransport = (request: HubRequest) => Promise<HubReply>;

function baseHeaders(anonKey: string): Record<string, string> {
  return {
    apikey: anonKey,
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": OPENLIMITER_USER_AGENT
  };
}

function buildRequest(
  environment: Readonly<Record<string, string | undefined>>,
  endpoint: HubEndpointId,
  body: unknown,
  bearer?: string
): HubRequest | null {
  if (!hubConfigured(environment)) return null;
  const encoded = JSON.stringify(body);
  if (encoded.length > MAX_HUB_REQUEST_BYTES) return null;
  const headers = baseHeaders(hubAnonKey(environment));
  if (bearer !== undefined) headers["authorization"] = "Bearer " + bearer;
  return {
    endpoint,
    url: hubBaseUrl(environment).replace(/\/$/u, "") + HUB_FUNCTION_PATHS[endpoint],
    method: "POST",
    headers,
    body: encoded
  };
}

/** The device flow's first call: mint a user code and a device code. */
export function cliLoginStartRequest(
  environment: Readonly<Record<string, string | undefined>>
): HubRequest | null {
  return buildRequest(environment, "cli_login", { action: "start" });
}

/** Shape of a device code this build will still poll with. */
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_.-]{8,256}$/u;

/** The device flow's poll: ask whether somebody has approved the code yet. */
export function cliLoginPollRequest(
  environment: Readonly<Record<string, string | undefined>>,
  deviceCode: string
): HubRequest | null {
  if (!DEVICE_CODE_PATTERN.test(deviceCode)) return null;
  return buildRequest(environment, "cli_login", { action: "poll", device_code: deviceCode });
}

/** Shape of a refresh credential this build will still spend. */
const REFRESH_CREDENTIAL_PATTERN = /^[\x21-\x7E]{16,4096}$/u;

/** Trade a refresh credential for a new token, rotating the credential. */
export function grantRenewRequest(
  environment: Readonly<Record<string, string | undefined>>,
  refreshCredential: string
): HubRequest | null {
  if (!REFRESH_CREDENTIAL_PATTERN.test(refreshCredential)) return null;
  return buildRequest(environment, "grant_renew", {
    action: "grant_renew",
    refresh_credential: refreshCredential
  });
}

/** Shape of a bearer token this build will still send. */
const BEARER_TOKEN_PATTERN = /^[\x21-\x7E]{16,32768}$/u;

/** Upload one sync envelope under the signed in account. */
export function syncSnapshotsRequest(
  environment: Readonly<Record<string, string | undefined>>,
  token: string,
  envelope: unknown
): HubRequest | null {
  if (!BEARER_TOKEN_PATTERN.test(token)) return null;
  return buildRequest(environment, "sync_snapshots", envelope, token);
}

/**
 * The transport the product uses, built on the runtime's own fetch.
 *
 * Redirects are refused, the body is bounded before it is decoded, and the
 * whole request lives under one deadline, exactly as the acquisition
 * transport in the core package does it.
 */
export function createFetchHubTransport(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch
): HubTransport {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HUB_TIMEOUT_MILLISECONDS);
    try {
      const response = await fetchImplementation(request.url, {
        method: request.method,
        headers: { ...request.headers },
        redirect: "error",
        signal: controller.signal,
        body: request.body
      });
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_HUB_RESPONSE_BYTES) {
        return { status: response.status, body: "" };
      }
      return {
        status: response.status,
        body: new TextDecoder("utf-8", { fatal: false }).decode(buffer)
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Parse a hub response body as JSON, or hand back nothing readable. */
export function parseHubJson(body: string): Record<string, unknown> | null {
  if (body.length === 0 || body.length > MAX_HUB_RESPONSE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
