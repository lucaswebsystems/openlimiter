import { SITE_URL } from "./site";

/**
 * OpenRouter's own documented PKCE flow, run entirely in the browser.
 *
 * `openrouter.ai/auth` is a real, published OAuth surface (see openrouter.ai's
 * own PKCE documentation), so this is the one connector in the product that
 * signs in with no vendor CLI and no desktop application in the loop: a
 * verifier is generated, its S256 challenge sent to OpenRouter, and the code
 * OpenRouter hands back is exchanged for a key that never leaves this
 * exchange except into the same `cloud-meter store` call every other cloud
 * metered key goes through.
 *
 * THE VERIFIER'S ONE TRIP THROUGH SESSION STORAGE
 * ------------------------------------------------
 * A PKCE verifier has to survive the round trip to OpenRouter and back, and
 * session storage is what a full navigation survives while a tab is still
 * open. It is written once, under a nonce this module also mints, and taken
 * back out (read and removed in the same call) the moment the callback page
 * reads it. The nonce travels inside the callback URL itself, as a query
 * parameter OpenRouter's redirect carries back untouched alongside its own
 * `code`, since OpenRouter's documented flow has no `state` parameter of its
 * own to round trip a value through.
 */

const AUTHORIZE_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_CALLBACK_PATH = "/app/openrouter/callback";

const VERIFIER_STORAGE_PREFIX = "openlimiter-openrouter-verifier-";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** A fresh, unguessable value naming this attempt, never a secret by itself. */
export function randomNonce(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** RFC 7636's verifier: 32 random bytes, base64url, well inside its length bounds. */
export function generateCodeVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 challenge a verifier produces. */
export async function codeChallengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** The address OpenRouter is told to return to, carrying this attempt's nonce. */
export function openRouterCallbackUrl(nonce: string): string {
  return `${SITE_URL}${OPENROUTER_CALLBACK_PATH}?n=${encodeURIComponent(nonce)}`;
}

export interface OpenRouterAuthorization {
  /** Where to send the browser. */
  url: string;
  /** Names the sessionStorage slot the verifier is about to be written to. */
  nonce: string;
  /** Kept only long enough to be handed to `storeOpenRouterVerifier`. */
  verifier: string;
}

/** Build the authorize address, and the verifier the callback will need. */
export async function buildOpenRouterAuthorization(): Promise<OpenRouterAuthorization> {
  const nonce = randomNonce();
  const verifier = generateCodeVerifier();
  const challenge = await codeChallengeOf(verifier);
  const params = new URLSearchParams({
    callback_url: openRouterCallbackUrl(nonce),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, nonce, verifier };
}

function verifierKey(nonce: string): string {
  return `${VERIFIER_STORAGE_PREFIX}${nonce}`;
}

/** Write the verifier under its nonce, the one time it is ever stored. */
export function storeOpenRouterVerifier(nonce: string, verifier: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(verifierKey(nonce), verifier);
  } catch {
    /* A browser refusing storage cannot complete this flow; the callback page
       reports it as any other missing verifier would be reported. */
  }
}

/** Read the verifier back and remove it in the same call. Never read twice. */
export function takeOpenRouterVerifier(nonce: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const key = verifierKey(nonce);
    const value = window.sessionStorage.getItem(key);
    if (value !== null) window.sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

export type OpenRouterExchangeOutcome = { ok: true; key: string } | { ok: false };

/**
 * Trade the code OpenRouter's redirect carried for the key it minted.
 *
 * The verifier is sent in the body, exactly as OpenRouter's documented
 * exchange expects, and is never logged or stored again after this call.
 */
export async function exchangeOpenRouterCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterExchangeOutcome> {
  try {
    const response = await fetchImpl(OPENROUTER_KEY_EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    });
    if (!response.ok) return { ok: false };
    const data: unknown = await response.json();
    const key =
      data !== null && typeof data === "object" && typeof (data as Record<string, unknown>).key === "string"
        ? ((data as Record<string, unknown>).key as string)
        : null;
    return key === null || key === "" ? { ok: false } : { ok: true, key };
  } catch {
    return { ok: false };
  }
}

/** The code and this attempt's nonce, read from the callback URL's query. */
export function openRouterCallbackParams(search: string): { code: string | null; nonce: string | null } {
  const params = new URLSearchParams(search);
  return { code: params.get("code"), nonce: params.get("n") };
}
