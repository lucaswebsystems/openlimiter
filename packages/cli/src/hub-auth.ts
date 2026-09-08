/**
 * Signing in to the hub, staying signed in, and reading who is signed in.
 *
 * The device flow itself is nothing this build invented: a code and an
 * address are shown, somebody types the code somewhere else, and this process
 * polls until the hub says approved, denied or expired. The hub is the only
 * clock that matters for expiry: it is the one thing that can say the device
 * code has lapsed, so this build never guesses at a deadline of its own. The
 * poll loop still carries a safety ceiling, derived from the hub's own stated
 * lifetime, so a stubbed or misbehaving transport in a test cannot spin it
 * forever.
 */
import {
  cliLoginPollRequest,
  cliLoginStartRequest,
  grantRenewRequest,
  hubConfigured,
  parseHubJson,
  type HubTransport
} from "./hub.js";
import {
  sessionIsFresh,
  type HubSession
} from "./session.js";

/** The sentence a hub side revocation prints, word for word. */
export const REVOKED_SENTENCE = "Signed out on the hub, run openlimiter login";

/** The sentence a login code the hub already consumed prints, word for word. */
export const CODE_CONSUMED_SENTENCE = "That code was already used, run openlimiter login again";

/** Extra polls past the hub's own stated lifetime, before this build gives up. */
export const LOGIN_SAFETY_MARGIN_POLLS = 5;

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isInstant(value: unknown): value is string {
  return isBoundedString(value, 1, 64) && Number.isFinite(Date.parse(value));
}

/**
 * Whether Ctrl C asked this poll loop to stop.
 *
 * A plain `signal?.aborted === true` reads fine once, but TypeScript narrows
 * that exact expression across the loop body, so a second identical check
 * after an `await` is seen as comparing an already narrowed `false` against
 * `true` and refused as unreachable. A function call has no such memory.
 */
export function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export interface LoginStart {
  readonly userCode: string;
  readonly deviceCode: string;
  readonly verificationUrl: string;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}

/** Parse the device flow's opening answer, trusting nothing about its shape. */
export function parseLoginStart(body: string): LoginStart | null {
  const parsed = parseHubJson(body);
  if (parsed === null) return null;
  const userCode = parsed["user_code"];
  const deviceCode = parsed["device_code"];
  const verificationUrl = parsed["verification_url"];
  const interval = parsed["interval"];
  const expiresIn = parsed["expires_in"];
  if (
    !isBoundedString(userCode, 1, 64) ||
    !isBoundedString(deviceCode, 1, 256) ||
    !isBoundedString(verificationUrl, 8, 512) ||
    !verificationUrl.startsWith("https://") ||
    !isFiniteInRange(interval, 1, 300) ||
    !isFiniteInRange(expiresIn, 1, 86_400)
  ) {
    return null;
  }
  return {
    userCode,
    deviceCode,
    verificationUrl,
    intervalSeconds: interval,
    expiresInSeconds: expiresIn
  };
}

export type LoginPollOutcome =
  | { readonly status: "pending" }
  | { readonly status: "slow_down" }
  | { readonly status: "denied" }
  | { readonly status: "expired" }
  | { readonly status: "consumed" }
  | {
      readonly status: "approved";
      readonly token: string;
      readonly expiresAt: string;
      readonly refreshCredential: string;
      readonly refreshExpiresAt: string;
      readonly deviceId: string;
    };

/** Parse one poll answer, in the five shapes the contract allows. */
export function parseLoginPoll(body: string): LoginPollOutcome | null {
  const parsed = parseHubJson(body);
  if (parsed === null) return null;
  const status = parsed["status"];
  if (
    status === "pending" ||
    status === "slow_down" ||
    status === "denied" ||
    status === "expired" ||
    status === "consumed"
  ) {
    return { status };
  }
  if (status !== "approved") return null;
  const token = parsed["token"];
  const expiresAt = parsed["expires_at"];
  const refreshCredential = parsed["refresh_credential"];
  const refreshExpiresAt = parsed["refresh_expires_at"];
  const deviceId = parsed["device_id"];
  if (
    !isBoundedString(token, 16, 32_768) ||
    !isInstant(expiresAt) ||
    !isBoundedString(refreshCredential, 16, 4_096) ||
    !isInstant(refreshExpiresAt) ||
    !isBoundedString(deviceId, 1, 128)
  ) {
    return null;
  }
  return { status: "approved", token, expiresAt, refreshCredential, refreshExpiresAt, deviceId };
}

export interface GrantRenewal {
  readonly token: string;
  readonly expiresAt: string;
  readonly refreshCredential: string;
  readonly refreshExpiresAt: string;
}

/** Parse a renewal answer: a fresh token and a rotated refresh credential. */
export function parseGrantRenewal(body: string): GrantRenewal | null {
  const parsed = parseHubJson(body);
  if (parsed === null) return null;
  const token = parsed["token"];
  const expiresAt = parsed["expires_at"];
  const refreshCredential = parsed["refresh_credential"];
  const refreshExpiresAt = parsed["refresh_expires_at"];
  if (
    !isBoundedString(token, 16, 32_768) ||
    !isInstant(expiresAt) ||
    !isBoundedString(refreshCredential, 16, 4_096) ||
    !isInstant(refreshExpiresAt)
  ) {
    return null;
  }
  return { token, expiresAt, refreshCredential, refreshExpiresAt };
}

function base64UrlDecode(segment: string): string | null {
  if (segment.length === 0 || segment.length > 16_384 || !/^[A-Za-z0-9_-]+$/u.test(segment)) {
    return null;
  }
  try {
    return Buffer.from(segment, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/**
 * A human name for the account, read from the token if it carries one.
 *
 * The hub contract names no account label field at all, and a token is the
 * one thing the approved answer definitely carries that could hold one: a
 * JSON Web Token's own payload, unsigned and unverified here because nothing
 * downstream trusts this label for anything but display. A token that is not
 * a JWT, or carries no email claim, falls back to the device id, which is
 * always there and is at least a stable name to look at with `whoami`.
 */
export function accountLabelFromToken(token: string, fallback: string): string {
  const segments = token.split(".");
  if (segments.length !== 3) return fallback;
  const payload = segments[1];
  if (payload === undefined) return fallback;
  const decoded = base64UrlDecode(payload);
  if (decoded === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const email = (parsed as Record<string, unknown>)["email"];
      if (typeof email === "string" && email.length > 0 && email.length <= 256) return email;
    }
  } catch {
    /* Not a JWT this build can read the claims of. The device id still names it. */
  }
  return fallback;
}

export interface DeviceLoginOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly transport: HubTransport;
  readonly sleep: (milliseconds: number) => Promise<void>;
  /** Progress this process wants seen before the command itself returns. */
  readonly emit: (line: string) => void;
  readonly interruptSignal?: AbortSignal;
  readonly openBrowser?: (url: string) => void;
  readonly open: boolean;
}

export type DeviceLoginResult =
  | { readonly kind: "signed_in"; readonly session: HubSession }
  | { readonly kind: "cancelled" }
  | { readonly kind: "denied" }
  | { readonly kind: "expired"; readonly message?: string }
  | { readonly kind: "not_configured" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Run the whole device flow: start, show the code, poll until an ending.
 *
 * `slow_down` widens the interval rather than being treated as a failure,
 * which is the device flow's own documented way of saying "you are polling
 * this endpoint too often". A poll that could not be sent or read is not
 * treated as `denied` either: a network blip inside a three minute window is
 * routine, and the loop tries again next interval rather than ending the
 * whole sign in over it.
 */
export async function runDeviceLogin(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  if (!hubConfigured(options.environment)) return { kind: "not_configured" };
  const startRequest = cliLoginStartRequest(options.environment);
  if (startRequest === null) return { kind: "not_configured" };
  let startReply;
  try {
    startReply = await options.transport(startRequest);
  } catch {
    return { kind: "error", message: "could not reach the hub" };
  }
  if (startReply.status < 200 || startReply.status >= 300) {
    return { kind: "error", message: "the hub refused the sign in request" };
  }
  const start = parseLoginStart(startReply.body);
  if (start === null) {
    return { kind: "error", message: "the hub answered with something this build could not read" };
  }
  options.emit("Enter this code: " + start.userCode);
  options.emit("At: " + start.verificationUrl);
  if (options.open) options.openBrowser?.(start.verificationUrl);
  let intervalSeconds = start.intervalSeconds;
  const maxAttempts = Math.ceil(start.expiresInSeconds / intervalSeconds) + LOGIN_SAFETY_MARGIN_POLLS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isAborted(options.interruptSignal)) return { kind: "cancelled" };
    await options.sleep(intervalSeconds * 1_000);
    if (isAborted(options.interruptSignal)) return { kind: "cancelled" };
    const pollRequest = cliLoginPollRequest(options.environment, start.deviceCode);
    if (pollRequest === null) return { kind: "error", message: "the device code could not be sent" };
    let pollReply;
    try {
      pollReply = await options.transport(pollRequest);
    } catch {
      continue;
    }
    if (pollReply.status === 403) return { kind: "denied" };
    if (pollReply.status === 409) return { kind: "expired", message: CODE_CONSUMED_SENTENCE };
    if (pollReply.status === 404 || pollReply.status === 410) return { kind: "expired" };
    if (pollReply.status < 200 || pollReply.status >= 300) continue;
    const poll = parseLoginPoll(pollReply.body);
    if (poll === null) continue;
    if (poll.status === "pending") continue;
    if (poll.status === "slow_down") {
      intervalSeconds += 5;
      continue;
    }
    if (poll.status === "denied") return { kind: "denied" };
    if (poll.status === "expired") return { kind: "expired" };
    if (poll.status === "consumed") return { kind: "expired", message: CODE_CONSUMED_SENTENCE };
    const session: HubSession = {
      version: 1,
      token: poll.token,
      expiresAt: poll.expiresAt,
      refreshCredential: poll.refreshCredential,
      refreshExpiresAt: poll.refreshExpiresAt,
      deviceId: poll.deviceId,
      accountLabel: accountLabelFromToken(poll.token, poll.deviceId)
    };
    return { kind: "signed_in", session };
  }
  return { kind: "expired" };
}

export type RenewOutcome =
  | { readonly kind: "fresh"; readonly session: HubSession }
  | { readonly kind: "renewed"; readonly session: HubSession }
  | { readonly kind: "revoked" }
  | { readonly kind: "error" };

/**
 * Make sure a session is good for one more upload, renewing if it is not.
 *
 * A session inside the renewal window is used exactly as it stands: renewing
 * early for no reason spends the one time use refresh credential for nothing.
 * A 401 from the renewal call is read as the hub having revoked this device,
 * never as an ordinary network failure, because the two need different
 * endings: one clears the session and asks for a fresh sign in, the other
 * leaves the session in place and lets the next attempt try again.
 */
export async function ensureFreshSession(
  session: HubSession,
  now: string,
  environment: Readonly<Record<string, string | undefined>>,
  transport: HubTransport
): Promise<RenewOutcome> {
  if (sessionIsFresh(session, now)) return { kind: "fresh", session };
  const request = grantRenewRequest(environment, session.refreshCredential);
  if (request === null) return { kind: "error" };
  let reply;
  try {
    reply = await transport(request);
  } catch {
    return { kind: "error" };
  }
  if (reply.status === 401) return { kind: "revoked" };
  if (reply.status < 200 || reply.status >= 300) return { kind: "error" };
  const renewal = parseGrantRenewal(reply.body);
  if (renewal === null) return { kind: "error" };
  return {
    kind: "renewed",
    session: {
      ...session,
      token: renewal.token,
      expiresAt: renewal.expiresAt,
      refreshCredential: renewal.refreshCredential,
      refreshExpiresAt: renewal.refreshExpiresAt
    }
  };
}
