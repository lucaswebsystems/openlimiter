/**
 * The paired phone's credential pair, and the renewal that keeps it alive.
 *
 * A successful pairing hands the phone two secrets in one answer: a read token
 * with a 24 hour life, and a refresh credential shown exactly once. Neither
 * secret is ever kept anywhere this browser's own JavaScript can read it
 * again. The moment this module has them, on the approving poll's response,
 * it hands them to the same-origin route handlers under app/app/pair/api,
 * which set them as HttpOnly, Secure, SameSite=Strict cookies scoped to that
 * one path. From then on this module, and every screen built on it, only ever
 * asks those routes to renew or to read; it never sees the token or the
 * credential again.
 *
 * What stays in this browser's local storage is a small, non-secret pairing
 * marker: a device label and the read token's own expiry. Neither one grants
 * access to anything by itself. The expiry exists so the page can decide when
 * a renewal is due without asking the server on every render, and the label
 * exists so a paired screen can say something more useful than "this phone".
 *
 * THE TWO HALVES OF THIS MODULE
 * ------------------------------
 * The wire parsing and the pure renew/read decisions (`phonePairOf`,
 * `renewPhonePair`, `readPhoneBars`, `isRevokedEpochResponse`) run on the
 * SERVER, inside the three route handlers, which are the only code that ever
 * holds the actual secrets. The browser facing helpers at the bottom
 * (`establishPhoneSession`, `requestPhoneRenewal`, `requestPhoneRead`,
 * `endPhoneSession`) run in the tab and talk to those routes over fetch,
 * carrying nothing but the local marker.
 */

import { readDeviceSnapshots, renewPhoneCredential, type HostedResponse } from "./pro-device";

/** Renew once the token is this close to its end, rather than at it. */
export const PHONE_RENEW_WITHIN_SECONDS = 3_600;

/**
 * How long the server honours a spent refresh credential, as a bound on the
 * one retry a lost renewal answer gets.
 *
 * This bounds wall clock time since the FIRST attempt started, not the number
 * of retries: a renewal call that itself took most of five minutes to fail is
 * not worth retrying, because the server's own grace for the credential it
 * already rotated will have run out by the time a second attempt lands.
 */
export const PHONE_RENEW_GRACE_SECONDS = 300;

/** Every cookie this feature sets lives only under this path. */
export const PHONE_COOKIE_PATH = "/app/pair/api";

/** The read token, HttpOnly, Secure, SameSite=Strict, path scoped. */
export const PHONE_TOKEN_COOKIE = "ol-phone-token";

/** The single use refresh credential, under the same protections. */
export const PHONE_REFRESH_COOKIE = "ol-phone-refresh";

/** The one local storage key for the non-secret pairing marker. */
export const PHONE_PAIR_META_KEY = "openlimiter-phone-pair-meta";

export interface PhonePair {
  /** The read scoped token, audience phone. Never stored in this browser. */
  token: string;
  /** Unix seconds. The token is not accepted after this. */
  expiresAt: number;
  /** The single use credential the next renewal carries. Never stored either. */
  refreshCredential: string;
  /** Unix seconds. No renewal is possible after this. */
  refreshExpiresAt: number;
}

/**
 * The non-secret marker this browser is allowed to keep: a label, and when
 * the current read token expires. Neither reads a meter or proves anything to
 * the server; both exist purely so this tab (and its siblings) know when to
 * ask for a renewal without a round trip on every render.
 */
export interface PhonePairMeta {
  label: string;
  expiresAt: number;
}

/* ------------------------------------------------------------ wire shape */

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function instantSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1_000);
  }
  return null;
}

/**
 * A delivery or a renewal answer, as the pair a route handler carries forward.
 *
 * The approving poll and `phone_renew` both answer the same four fields, so
 * both go through this one parser. Null means the answer was not a credential
 * pair, and nothing partially parsed is ever kept.
 */
export function phonePairOf(value: unknown): PhonePair | null {
  const row = record(value);
  if (row === null) return null;
  const token = typeof row.token === "string" ? row.token : "";
  const refreshCredential =
    typeof row.refresh_credential === "string" ? row.refresh_credential : "";
  const expiresAt = instantSeconds(row.expires_at);
  const refreshExpiresAt = instantSeconds(row.refresh_expires_at);
  if (token === "" || refreshCredential === "" || expiresAt === null || refreshExpiresAt === null) {
    return null;
  }
  return { token, expiresAt, refreshCredential, refreshExpiresAt };
}

/* ---------------------------------------------------- the non-secret marker */

function metaRecord(value: unknown): PhonePairMeta | null {
  const row = record(value);
  if (row === null) return null;
  const label = typeof row.label === "string" ? row.label : "";
  const expiresAt = instantSeconds(row.expiresAt);
  if (label === "" || expiresAt === null) return null;
  return { label, expiresAt };
}

/** The stored marker, or null when there is none or it cannot be trusted. */
export function readPhonePairMeta(): PhonePairMeta | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PHONE_PAIR_META_KEY);
    return raw === null ? null : metaRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writePhonePairMeta(meta: PhonePairMeta): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PHONE_PAIR_META_KEY, JSON.stringify(meta));
  } catch {
    /* A browser with storage refused keeps the marker in memory only. */
  }
}

export function clearPhonePairMeta(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PHONE_PAIR_META_KEY);
  } catch {
    /* Nothing to clear if storage was never available. */
  }
}

/** Whether the current token, per the local marker, should be renewed now. */
export function phonePairNeedsRenewal(
  entity: { expiresAt: number },
  now: number = Date.now(),
): boolean {
  return entity.expiresAt * 1_000 - now <= PHONE_RENEW_WITHIN_SECONDS * 1_000;
}

/* --------------------------------------------------- the explicit signal */

/**
 * Whether a response carries the server's own, explicit "this pairing is
 * revoked" signal, and nothing weaker than that.
 *
 * `phone_renew` answers 403 with this exact message only when the RPC itself
 * reports `epoch_revoked`, meaning the desktop bumped the revocation epoch and
 * this phone's grant is gone for good. Every other failure the same call can
 * produce, a dead refresh credential, a device that is no longer active, a
 * grace window that has run out, still answers 401 with a different message,
 * because none of those says the pairing itself ended. `read_snapshots` never
 * distinguishes at all: an invalid token there is always the one word
 * "unpaired", whether the reason is a stale token or a revoked epoch, so a
 * read alone can never prove revocation either way. This is why the read path
 * never revokes on its own: only a renewal can hear the server say so.
 */
export function isRevokedEpochResponse(response: HostedResponse): boolean {
  if (response.status !== 403) return false;
  const body = record(response.body);
  return typeof body?.error === "string" && body.error.toLowerCase().includes("revocation");
}

/* -------------------------------------------------------------- renewal */

export type RenewOutcome =
  | { kind: "renewed"; pair: PhonePair }
  | { kind: "revoked" }
  | { kind: "unavailable" };

interface RenewAttempt {
  /** True only when the call never reached the server: no response at all. */
  transportLoss: boolean;
  outcome: RenewOutcome;
}

async function renewAttempt(
  pair: PhonePair,
  call: (refreshCredential: string) => Promise<HostedResponse>,
): Promise<RenewAttempt> {
  let response: HostedResponse;
  try {
    response = await call(pair.refreshCredential);
  } catch {
    return { transportLoss: true, outcome: { kind: "unavailable" } };
  }
  /* lib/pro-device.ts answers status 0 for a fetch that never got a response:
     a network error or a timeout, never a status the server actually sent. */
  if (response.status === 0) {
    return { transportLoss: true, outcome: { kind: "unavailable" } };
  }
  if (isRevokedEpochResponse(response)) {
    return { transportLoss: false, outcome: { kind: "revoked" } };
  }
  if (response.status !== 200) {
    return { transportLoss: false, outcome: { kind: "unavailable" } };
  }
  const next = phonePairOf(response.body);
  return {
    transportLoss: false,
    outcome: next === null ? { kind: "unavailable" } : { kind: "renewed", pair: next },
  };
}

/**
 * Renew through `phone_renew`, with exactly one retry, and only when the
 * first attempt never reached the server at all.
 *
 * A dropped response is recoverable: the server may already have rotated the
 * credential, and it honours the previous one once more inside its own grace
 * window, so trying again with the same credential is safe and worth doing.
 * An HTTP error is not the same kind of failure. A 401 or a 403 the server
 * actually sent is the server's answer, not a lost one, and retrying it
 * changes nothing: the same credential produces the same refusal. Retrying
 * only transport loss, and only while the server's grace window could still
 * apply, is what keeps this from turning a real refusal into a second one.
 */
export async function renewPhonePair(
  pair: PhonePair,
  call: (refreshCredential: string) => Promise<HostedResponse> = renewPhoneCredential,
  now: () => number = Date.now,
): Promise<RenewOutcome> {
  const startedAt = now();
  const first = await renewAttempt(pair, call);
  if (!first.transportLoss) return first.outcome;
  if (now() - startedAt >= PHONE_RENEW_GRACE_SECONDS * 1_000) return { kind: "unavailable" };
  const second = await renewAttempt(pair, call);
  return second.outcome;
}

/* -------------------------------------------------------------- the read */

export type PhoneRead =
  | { kind: "fresh"; body: unknown }
  | { kind: "revoked" }
  | { kind: "unpaired" }
  | { kind: "empty" };

/**
 * One read of the account's meters, as a route handler sees it.
 *
 * A transport failure or an upstream error keeps the last good bars rather
 * than clearing the screen: being offline on a phone is ordinary, and the
 * reader has no way to tell it apart from a service hiccup. `read_snapshots`
 * never carries the explicit revoked epoch signal (see
 * `isRevokedEpochResponse`), so in practice a read alone never ends a
 * pairing; that only happens through a renewal that hears the server say so.
 * The check stays here anyway, so a future contract change that does add the
 * signal to this endpoint is honoured without another patch.
 *
 * A 401 is read differently from every other failure: `read_snapshots`
 * answers it, and only it, for a token this server no longer accepts at all,
 * whether the cause is a stale token or a revoked epoch. That is not a
 * service hiccup the phone should quietly retry through; it is the same
 * "scan again" state a missing cookie already reports, so the route below
 * forwards it as `unpaired` rather than folding it into `empty`.
 */
export async function readPhoneBars(
  pair: PhonePair,
  call: (token: string) => Promise<HostedResponse> = readDeviceSnapshots,
): Promise<PhoneRead> {
  let response: HostedResponse;
  try {
    response = await call(pair.token);
  } catch {
    return { kind: "empty" };
  }
  if (isRevokedEpochResponse(response)) return { kind: "revoked" };
  if (response.status === 401) return { kind: "unpaired" };
  if (response.status !== 200) return { kind: "empty" };
  return { kind: "fresh", body: response.body };
}

/* ======================================================================= */
/* Browser facing helpers. Everything below runs in the tab and never holds
   a secret; it only calls the same-origin routes that do.                  */
/* ======================================================================= */

async function postJson(path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: null };
  }
}

/**
 * Hand a freshly delivered pair to the session route, once.
 *
 * This is the only place a token or a refresh credential this browser ever
 * received leaves memory for storage of any kind, and it goes straight to a
 * same-origin route that stores it as an HttpOnly cookie. The non-secret
 * marker (label, read token expiry) is written locally only after that route
 * confirms the cookies are set.
 */
export async function establishPhoneSession(pair: PhonePair, label: string): Promise<boolean> {
  const answer = await postJson("/app/pair/api/session", {
    token: pair.token,
    expires_at: pair.expiresAt,
    refresh_credential: pair.refreshCredential,
    refresh_expires_at: pair.refreshExpiresAt,
  });
  if (answer.status !== 200) return false;
  writePhonePairMeta({ label, expiresAt: pair.expiresAt });
  return true;
}

/** End the pairing: clear both cookies server side, then the local marker. */
export async function endPhoneSession(): Promise<void> {
  try {
    await fetch("/app/pair/api/session", { method: "DELETE", credentials: "same-origin" });
  } catch {
    /* The marker is cleared either way; a phone that cannot reach the server
       cannot be un-paired remotely, but it can still forget locally. */
  }
  clearPhonePairMeta();
}

export type RenewSessionOutcome =
  | { kind: "renewed"; expiresAt: number }
  | { kind: "revoked" }
  | { kind: "unavailable" }
  | { kind: "skipped"; expiresAt: number };

/** The fixed name every tab requests the same Web Lock under. */
const RENEW_LOCK_NAME = "openlimiter-phone-renew";

async function renewOnce(): Promise<RenewSessionOutcome> {
  const answer = await postJson("/app/pair/api/renew");
  if (answer.status === 403) {
    clearPhonePairMeta();
    return { kind: "revoked" };
  }
  const body = record(answer.body);
  const expiresAt = instantSeconds(body?.expires_at);
  if (answer.status !== 200 || expiresAt === null) {
    return { kind: "unavailable" };
  }
  const meta = readPhonePairMeta();
  writePhonePairMeta({ label: meta?.label ?? "This phone", expiresAt });
  return { kind: "renewed", expiresAt };
}

/**
 * Ask for a renewal, serialised across every tab this account has open.
 *
 * Two tabs racing to renew is exactly the bug this fixes: without a lock, both
 * see the same stale expiry, both call the renewal route, and the server's
 * grace covers the double call but the LAST response to land in local storage
 * wins, which is a coin flip on which tab's rotated credential survives.
 *
 * Holding a Web Lock while renewing serialises the calls themselves, and
 * rereading the marker after the lock is acquired is what lets the second tab
 * notice the first one already finished: if the marker now shows a token that
 * is not due for renewal, this tab's own reason to renew is gone and it skips
 * the call entirely rather than rotating a credential that was just rotated a
 * moment ago.
 */
export async function requestPhoneRenewal(): Promise<RenewSessionOutcome> {
  if (typeof navigator === "undefined" || !("locks" in navigator) || navigator.locks == null) {
    return renewOnce();
  }
  return navigator.locks.request(RENEW_LOCK_NAME, async () => {
    const meta = readPhonePairMeta();
    if (meta !== null && !phonePairNeedsRenewal(meta)) {
      return { kind: "skipped", expiresAt: meta.expiresAt };
    }
    return renewOnce();
  });
}

export type PhoneReadOutcome =
  | { kind: "fresh"; body: unknown }
  | { kind: "revoked" }
  | { kind: "unpaired" }
  | { kind: "empty" };

/** Read the account's meters through the same-origin route. */
export async function requestPhoneRead(): Promise<PhoneReadOutcome> {
  const answer = await postJson("/app/pair/api/read");
  if (answer.status === 401) {
    const body = record(answer.body);
    return body?.error === "no_pair" ? { kind: "unpaired" } : { kind: "empty" };
  }
  if (answer.status === 403) return { kind: "revoked" };
  if (answer.status !== 200) return { kind: "empty" };
  const body = record(answer.body);
  return { kind: "fresh", body: body?.body ?? null };
}
