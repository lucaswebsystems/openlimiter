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
  createHash,
  randomBytes
} from "node:crypto";
import {
  cliLoginAckRequest,
  cliLoginPollRequest,
  cliLoginStartRequest,
  grantRenewRequest,
  hubConfigured,
  parseHubJson,
  type HubTransport
} from "./hub.js";
import {
  sessionIsFresh,
  StorageDiagnosticError,
  type HubSession,
  type StorageDiagnostic
} from "./session.js";

/** The sentence a hub side revocation prints, word for word. */
export const REVOKED_SENTENCE = "Signed out on the hub, run openlimiter login";

/** The sentence a login code the hub already consumed prints, word for word. */
export const CODE_CONSUMED_SENTENCE = "That code was already used, run openlimiter login again";
export const DELIVERY_UNCONFIRMED_SENTENCE = "The server could not confirm delivery, but the session is usable.";

/** Extra polls past the hub's own stated lifetime, before this build gives up. */
export const LOGIN_SAFETY_MARGIN_POLLS = 5;
export const MAX_SERVER_ERROR_RETRIES = 3;
const MAX_RETRY_INTERVAL_SECONDS = 30;

function isFiniteInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}

function isInstant(value: unknown): value is string {
  return isBoundedString(value, 1, 64) && Number.isFinite(Date.parse(value));
}

function serverMessage(body: string, secrets: readonly string[] = []): string | null {
  const parsed = parseHubJson(body);
  if (parsed === null) return null;
  for (const field of ["message", "error", "detail"]) {
    const value = parsed[field];
    if (
      isBoundedString(value, 1, 512) &&
      secrets.every((secret) => secret.length === 0 || !value.includes(secret))
    ) {
      return value;
    }
  }
  return null;
}

function nextBackoffInterval(intervalSeconds: number, retryAfterSeconds: number | null | undefined): number {
  return Math.min(
    MAX_RETRY_INTERVAL_SECONDS,
    Math.max(
      intervalSeconds * 2,
      typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : 0
    )
  );
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
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Progress this process wants seen before the command itself returns. */
  readonly emit: (line: string) => void;
  readonly interruptSignal?: AbortSignal;
  readonly openBrowser?: (url: string) => void;
  readonly open: boolean;
  /** Persist an approved session before the hub is told that delivery succeeded. */
  readonly storeSession?: (session: HubSession) => Promise<void>;
}

export type DeviceLoginResult =
  | { readonly kind: "signed_in"; readonly session: HubSession; readonly deliveryConfirmed: boolean }
  | { readonly kind: "cancelled" }
  | { readonly kind: "denied"; readonly message?: string }
  | { readonly kind: "expired"; readonly message?: string }
  | { readonly kind: "not_configured" }
  | { readonly kind: "storage_error"; readonly message: string; readonly diagnostic: StorageDiagnostic }
  | { readonly kind: "error"; readonly message: string };

type DeliveryAcknowledgement =
  | { readonly kind: "confirmed" }
  | { readonly kind: "unconfirmed" }
  | { readonly kind: "error"; readonly message: string };

async function acknowledgeDelivery(
  options: DeviceLoginOptions,
  start: LoginStart,
  deviceCode: string,
  token: string,
  clientProof: string,
  initialIntervalSeconds: number,
  deadline: number,
  signal: AbortSignal
): Promise<DeliveryAcknowledgement> {
  let intervalSeconds = initialIntervalSeconds;
  const maxAttempts = Math.ceil(start.expiresInSeconds / initialIntervalSeconds) + LOGIN_SAFETY_MARGIN_POLLS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (isAborted(signal) || Date.now() >= deadline) return { kind: "unconfirmed" };
    const request = cliLoginAckRequest(options.environment, deviceCode, token, clientProof);
    if (request === null) return { kind: "error", message: "the delivery acknowledgement could not be sent" };
    let reply;
    try {
      reply = await awaitWithSignal(options.transport(request, signal), signal);
    } catch {
      if (attempt + 1 >= maxAttempts || Date.now() >= deadline) return { kind: "unconfirmed" };
      if (!(await sleepWithSignal(options, Math.min(intervalSeconds * 1_000, Math.max(0, deadline - Date.now())), signal))) {
        return { kind: "unconfirmed" };
      }
      intervalSeconds = Math.min(MAX_RETRY_INTERVAL_SECONDS, intervalSeconds * 2);
      continue;
    }
    if (isAborted(signal) || Date.now() >= deadline) return { kind: "unconfirmed" };
    if (reply.status === 403 || reply.status === 404 || reply.status === 410) {
      return { kind: "unconfirmed" };
    }
    if (reply.status >= 200 && reply.status < 300) {
      const parsed = parseHubJson(reply.body);
      return parsed?.["status"] === "consumed"
        ? { kind: "confirmed" }
        : { kind: "unconfirmed" };
    }
    if (reply.status === 429 || reply.status === 503 || (reply.status >= 500 && reply.status <= 599)) {
      if (attempt + 1 >= maxAttempts || Date.now() >= deadline) return { kind: "unconfirmed" };
      intervalSeconds = nextBackoffInterval(intervalSeconds, reply.retryAfterSeconds);
      if (!(await sleepWithSignal(options, Math.min(intervalSeconds * 1_000, Math.max(0, deadline - Date.now())), signal))) {
        return { kind: "unconfirmed" };
      }
      continue;
    }
    return {
      kind: "error",
      message: "the hub returned status " + reply.status + " while confirming sign in"
    };
  }
  return { kind: "unconfirmed" };
}

function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function sleepWithSignal(
  options: DeviceLoginOptions,
  milliseconds: number,
  signal: AbortSignal
): Promise<boolean> {
  if (milliseconds <= 0 || isAborted(signal)) return false;
  try {
    await awaitWithSignal(options.sleep(milliseconds, signal), signal);
  } catch (error) {
    if (isAborted(signal)) return false;
    throw error;
  }
  return !isAborted(signal);
}

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
  const clientProof = randomBytes(32).toString("base64url");
  const clientProofHash = createHash("sha256").update(clientProof, "utf8").digest("base64url");
  const startRequest = cliLoginStartRequest(options.environment, clientProofHash);
  if (startRequest === null) return { kind: "not_configured" };
  const loginController = new AbortController();
  const signal = loginController.signal;
  const forwardAbort = (): void => loginController.abort();
  if (options.interruptSignal?.aborted) loginController.abort();
  else options.interruptSignal?.addEventListener("abort", forwardAbort, { once: true });
  let startReply;
  try {
    startReply = await awaitWithSignal(options.transport(startRequest, signal), signal);
  } catch {
    options.interruptSignal?.removeEventListener("abort", forwardAbort);
    if (isAborted(signal)) return { kind: "cancelled" };
    return { kind: "error", message: "could not reach the hub" };
  }
  if (startReply.status < 200 || startReply.status >= 300) {
    options.interruptSignal?.removeEventListener("abort", forwardAbort);
    return { kind: "error", message: "the hub refused the sign in request" };
  }
  const start = parseLoginStart(startReply.body);
  if (start === null) {
    options.interruptSignal?.removeEventListener("abort", forwardAbort);
    return { kind: "error", message: "the hub answered with something this build could not read" };
  }
  const deadline = Date.now() + start.expiresInSeconds * 1_000;
  options.emit("Enter this code: " + start.userCode);
  options.emit("At: " + start.verificationUrl);
  if (options.open) options.openBrowser?.(start.verificationUrl);
  const deadlineTimer = setTimeout(() => loginController.abort(), Math.max(0, deadline - Date.now()));
  let intervalSeconds = start.intervalSeconds;
  let serverErrorRetries = 0;
  const maxAttempts = Math.ceil(start.expiresInSeconds / intervalSeconds) + LOGIN_SAFETY_MARGIN_POLLS;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (isAborted(signal)) return { kind: Date.now() >= deadline ? "expired" : "cancelled" };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "expired" };
      if (!(await sleepWithSignal(options, Math.min(intervalSeconds * 1_000, remaining), signal))) {
        return { kind: Date.now() >= deadline ? "expired" : "cancelled" };
      }
      if (isAborted(signal) || Date.now() >= deadline) return { kind: "expired" };
      const pollRequest = cliLoginPollRequest(options.environment, start.deviceCode, clientProof);
      if (pollRequest === null) return { kind: "error", message: "the device code could not be sent" };
      let pollReply;
      try {
        pollReply = await awaitWithSignal(options.transport(pollRequest, signal), signal);
      } catch {
        if (isAborted(signal)) return { kind: Date.now() >= deadline ? "expired" : "cancelled" };
        continue;
      }
      if (isAborted(signal)) return { kind: Date.now() >= deadline ? "expired" : "cancelled" };
    if (pollReply.status === 403) {
      const message = serverMessage(pollReply.body, [clientProof]);
      return message === null ? { kind: "denied" } : { kind: "denied", message };
    }
    if (pollReply.status === 409) return { kind: "expired", message: CODE_CONSUMED_SENTENCE };
    if (pollReply.status === 404 || pollReply.status === 410) return { kind: "expired" };
    if (pollReply.status === 429 || pollReply.status === 503) {
      const retryAfter = pollReply.retryAfterSeconds;
      intervalSeconds = nextBackoffInterval(intervalSeconds, retryAfter);
      continue;
    }
    if (pollReply.status >= 500 && pollReply.status <= 599) {
      serverErrorRetries += 1;
      if (serverErrorRetries > MAX_SERVER_ERROR_RETRIES) {
        return {
          kind: "error",
          message: "the hub returned status " + pollReply.status + " while checking sign in"
        };
      }
      intervalSeconds = Math.min(MAX_RETRY_INTERVAL_SECONDS, intervalSeconds * 2);
      continue;
    }
    if (pollReply.status === 202) continue;
    if (pollReply.status !== 200) {
      return {
        kind: "error",
        message: "the hub returned status " + pollReply.status + " while checking sign in"
      };
    }
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
    try {
      await options.storeSession?.(session);
    } catch (error) {
      if (error instanceof StorageDiagnosticError) {
        return { kind: "storage_error", message: error.message, diagnostic: error.diagnostic };
      }
      return { kind: "error", message: "could not save the signed in session" };
    }
    const acknowledgement = await acknowledgeDelivery(
      options,
      start,
      start.deviceCode,
      session.token,
      clientProof,
      intervalSeconds,
      deadline,
      signal
    );
    if (acknowledgement.kind === "error") return acknowledgement;
    return { kind: "signed_in", session, deliveryConfirmed: acknowledgement.kind === "confirmed" };
    }
    return { kind: "expired" };
  } finally {
    clearTimeout(deadlineTimer);
    options.interruptSignal?.removeEventListener("abort", forwardAbort);
  }
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
