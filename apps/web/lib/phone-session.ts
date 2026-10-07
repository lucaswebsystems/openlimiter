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
import { meterRowsOf } from "./device-snapshots";

/** Renew once the token is this close to its end, rather than at it. */
export const PHONE_RENEW_WITHIN_SECONDS = 12 * 3_600;

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
export const PHONE_LAST_BARS_KEY = "openlimiter-phone-last-bars";
export const PHONE_PAIRING_GENERATION_KEY = "openlimiter-phone-pairing-generation";
export const PHONE_LAST_BARS_VERSION = 1;
const PHONE_LAST_BARS_LIMIT = 128;
const PHONE_DISABLED_KEY = "openlimiter-phone-disabled";
const PHONE_PAIRING_PENDING_KEY = "openlimiter-phone-pairing-pending";
const PHONE_PAIRING_OWNER_KEY = "openlimiter-phone-pairing-owner";
const PHONE_PAIRING_LEASE_MILLISECONDS = 15_000;

function phoneDisabled(): boolean {
  try { return typeof window !== "undefined" && window.localStorage.getItem(PHONE_DISABLED_KEY) === "true"; }
  catch { return false; }
}

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
    if (window.localStorage.getItem(PHONE_PAIRING_GENERATION_KEY) === null) {
      window.localStorage.setItem(PHONE_PAIRING_GENERATION_KEY, crypto.randomUUID());
    }
  } catch {
    /* A browser with storage refused keeps the marker in memory only. */
  }
}

export function clearPhonePairMeta(): void {
  if (typeof window === "undefined") return;
  pendingReplacement = null;
  try {
    window.localStorage.removeItem(PHONE_PAIR_META_KEY);
    window.localStorage.removeItem(PHONE_LAST_BARS_KEY);
    window.localStorage.removeItem(PHONE_PAIRING_GENERATION_KEY);
    window.localStorage.removeItem(PHONE_PAIRING_PENDING_KEY);
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
  | { kind: "unpaired" }
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
  const responseError = record(response.body)?.error;
  if (response.status === 401 && (responseError === "no_pair" || responseError === "unpaired")) {
    return { transportLoss: false, outcome: { kind: "unpaired" } };
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
      signal: AbortSignal.timeout(10_000),
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
  invalidatePhoneRequests();
  const replacement = crypto.randomUUID();
  pendingReplacement = replacement;
  writePairingReplacementLease(replacement);
  const current = phoneRequestGuard();
  const answer = await postJson("/app/pair/api/session", {
    token: pair.token,
    expires_at: pair.expiresAt,
    refresh_credential: pair.refreshCredential,
    refresh_expires_at: pair.refreshExpiresAt,
  });
  if (!current() || answer.status !== 200) {
    clearPairingReplacementLease(replacement);
    if (pendingReplacement === replacement) pendingReplacement = null;
    return false;
  }
  try { window.localStorage.removeItem(PHONE_DISABLED_KEY); } catch { /* Storage refused. */ }
  writePhonePairMeta({ label, expiresAt: pair.expiresAt });
  try {
    window.localStorage.setItem(PHONE_PAIRING_GENERATION_KEY, crypto.randomUUID());
  } catch { /* The in-tab request revision still fences this replacement. */ }
  clearPairingReplacementLease(replacement);
  if (pendingReplacement === replacement) pendingReplacement = null;
  return true;
}

/** End the pairing: clear both cookies server side, then the local marker. */
export async function endPhoneSession(): Promise<void> {
  invalidatePhoneRequests();
  clearPhonePairMeta();
  // Block recovery from cookies if logout happens offline or a read is still running.
  try { window.localStorage.setItem(PHONE_DISABLED_KEY, "true"); } catch { /* Storage refused. */ }
  try {
    await fetch("/app/pair/api/session", { method: "DELETE", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    /* The marker is cleared either way; a phone that cannot reach the server
       cannot be un-paired remotely, but it can still forget locally. */
  }
}

export type RenewSessionOutcome =
  | { kind: "renewed"; expiresAt: number }
  | { kind: "revoked" }
  | { kind: "unpaired" }
  | { kind: "unavailable" }
  | { kind: "superseded" }
  | { kind: "skipped"; expiresAt: number };

/** The fixed name every tab requests the same Web Lock under. */
const RENEW_LOCK_NAME = "openlimiter-phone-renew";

async function renewOnce(): Promise<RenewSessionOutcome> {
  const pairingGeneration = currentPairingGeneration();
  const current = phoneRequestGuard();
  if (phoneDisabled()) return { kind: "unpaired" };
  const answer = await postJson("/app/pair/api/renew");
  const invalidated = phoneRequestInvalidation(current, pairingGeneration);
  if (invalidated !== null) return { kind: invalidated };
  if (answer.status === 403) {
    clearPhonePairMeta();
    return { kind: "revoked" };
  }
  const answerBody = record(answer.body);
  if (answer.status === 401 && answerBody?.error === "no_pair") {
    clearPhonePairMeta();
    return { kind: "unpaired" };
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
let renewalFlight: Promise<RenewSessionOutcome> | null = null;

let phoneGeneration = 0;
let pendingReplacement: string | null = null;
let fallbackPairingOwner: string | null = null;
const PHONE_REVISION_KEY = "openlimiter-phone-session-revision";
function storedRevision(): string | null {
  try { return window.localStorage.getItem(PHONE_REVISION_KEY); } catch { return null; }
}
function storedPairingGeneration(): string | null {
  try { return window.localStorage.getItem(PHONE_PAIRING_GENERATION_KEY); } catch { return null; }
}
function invalidatePhoneRequests(): void {
  phoneGeneration += 1;
  renewalFlight = null;
  try { window.localStorage.removeItem(PHONE_LAST_BARS_KEY); } catch { /* Storage is optional. */ }
  try { window.localStorage.setItem(PHONE_REVISION_KEY, crypto.randomUUID()); } catch { /* Memory still fences this tab. */ }
}
interface PairingReplacementLease {
  owner: string;
  replacement: string;
  expiresAt: number;
}
function pairingOwner(): string {
  if (fallbackPairingOwner === null) fallbackPairingOwner = crypto.randomUUID();
  try {
    const stored = window.sessionStorage.getItem(PHONE_PAIRING_OWNER_KEY);
    if (stored !== null) return stored;
    window.sessionStorage.setItem(PHONE_PAIRING_OWNER_KEY, fallbackPairingOwner);
  } catch { /* The module owner still recovers this tab while it remains loaded. */ }
  return fallbackPairingOwner;
}
function pairingReplacementLease(): PairingReplacementLease | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(PHONE_PAIRING_PENDING_KEY) ?? "null") as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const lease = value as Partial<PairingReplacementLease>;
    return typeof lease.owner === "string" && typeof lease.replacement === "string" &&
      typeof lease.expiresAt === "number" && Number.isFinite(lease.expiresAt)
      ? lease as PairingReplacementLease : null;
  } catch { return null; }
}
function writePairingReplacementLease(replacement: string): void {
  try {
    window.localStorage.setItem(PHONE_PAIRING_PENDING_KEY, JSON.stringify({
      owner: pairingOwner(),
      replacement,
      expiresAt: Date.now() + PHONE_PAIRING_LEASE_MILLISECONDS,
    } satisfies PairingReplacementLease));
  } catch { /* This tab still fences its own reads in memory. */ }
}
function clearPairingReplacementLease(replacement: string): void {
  try {
    if (pairingReplacementLease()?.replacement === replacement) {
      window.localStorage.removeItem(PHONE_PAIRING_PENDING_KEY);
    }
  } catch { /* Storage is optional. */ }
}
function discardUncertainPairingState(): void {
  pendingReplacement = null;
  invalidatePhoneRequests();
  try {
    window.localStorage.removeItem(PHONE_PAIR_META_KEY);
    window.localStorage.removeItem(PHONE_PAIRING_GENERATION_KEY);
    window.localStorage.removeItem(PHONE_PAIRING_PENDING_KEY);
  } catch { /* A verified cookie read can still recover without storage. */ }
}
function pairingReplacementPending(): boolean {
  if (pendingReplacement !== null) return true;
  let markerPresent = false;
  try { markerPresent = window.localStorage.getItem(PHONE_PAIRING_PENDING_KEY) !== null; }
  catch { return false; }
  if (!markerPresent) return false;
  const lease = pairingReplacementLease();
  if (lease !== null && lease.owner !== pairingOwner() && lease.expiresAt > Date.now()) return true;
  discardUncertainPairingState();
  return false;
}
function phoneRequestGuard(): () => boolean {
  const generation = phoneGeneration;
  const revision = storedRevision();
  return () => generation === phoneGeneration && revision === storedRevision();
}
function currentPairingGeneration(): string | null {
  if (readPhonePairMeta() !== null && storedPairingGeneration() === null) {
    try { window.localStorage.setItem(PHONE_PAIRING_GENERATION_KEY, crypto.randomUUID()); }
    catch { /* A current request can still be fenced by its in-tab revision. */ }
  }
  return storedPairingGeneration();
}
function phoneRequestInvalidation(
  current: () => boolean,
  pairingGeneration: string | null,
): "superseded" | "unpaired" | null {
  if (pairingReplacementPending()) return "superseded";
  const latestPairingGeneration = storedPairingGeneration();
  if (latestPairingGeneration !== null && latestPairingGeneration !== pairingGeneration) {
    return "superseded";
  }
  if (!current() || phoneDisabled()) return "unpaired";
  return null;
}

/** Lamport's bakery lock for browsers without Web Locks. Tickets are per tab attempt.
 * A lease outlives the bounded fetch; an expired waiter never starts a request.
 * Refused shared storage fails closed, rather than rotating without exclusion.
 */
async function storageRenewalLock(run: () => Promise<RenewSessionOutcome>): Promise<RenewSessionOutcome> {
  const prefix = `${RENEW_LOCK_NAME}:`;
  const id = crypto.randomUUID();
  const key = prefix + id;
  const until = Date.now() + 30_000;
  try {
    const store = window.localStorage;
    const entries = () => Array.from({ length: store.length }, (_, index) => store.key(index))
      .filter((name): name is string => name !== null && name.startsWith(prefix))
      .map((name) => ({ name, ...JSON.parse(store.getItem(name) ?? "null") as { ticket: number; until: number } }))
      .filter((entry) => entry.until > Date.now());
    store.setItem(key, JSON.stringify({ ticket: 0, until }));
    const ticket = 1 + Math.max(0, ...entries().map((entry) => entry.ticket));
    store.setItem(key, JSON.stringify({ ticket, until }));
    if (store.getItem(key) === null) return { kind: "unavailable" };
    while (entries().some((entry) => entry.name !== key &&
      (entry.ticket === 0 || entry.ticket < ticket || (entry.ticket === ticket && entry.name < key)))) {
      if (Date.now() + 10_000 >= until) return { kind: "unavailable" };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (Date.now() + 10_000 >= until) return { kind: "unavailable" };
    return await run();
  } catch {
    return { kind: "unavailable" };
  } finally {
    try { window.localStorage.removeItem(key); } catch { /* Lease expires on its own. */ }
  }
}

export function requestPhoneRenewal(force = false): Promise<RenewSessionOutcome> {
  if (renewalFlight) return renewalFlight;
  if (pairingReplacementPending()) return Promise.resolve({ kind: "superseded" });
  const pairingGeneration = currentPairingGeneration();
  const current = phoneRequestGuard();
  const initialExpiry = readPhonePairMeta()?.expiresAt;
  const renew = async (): Promise<RenewSessionOutcome> => {
    const invalidated = phoneRequestInvalidation(current, pairingGeneration);
    if (invalidated !== null) return { kind: invalidated };
    const meta = readPhonePairMeta();
    if (meta !== null && ((!force && !phonePairNeedsRenewal(meta)) || (force && meta.expiresAt !== initialExpiry))) {
      return { kind: "skipped", expiresAt: meta.expiresAt };
    }
    return renewOnce();
  };
  const request = typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request(RENEW_LOCK_NAME, renew)
    : storageRenewalLock(renew);
  const flight = Promise.resolve(request).then((answer): RenewSessionOutcome => {
    const invalidated = phoneRequestInvalidation(current, pairingGeneration);
    return invalidated === null ? answer : { kind: invalidated };
  }).finally(() => {
    if (renewalFlight === flight) renewalFlight = null;
  });
  renewalFlight = flight;
  return renewalFlight;
}

export type PhoneReadOutcome =
  | { kind: "fresh"; body: unknown }
  | { kind: "revoked" }
  | { kind: "unpaired" }
  | { kind: "superseded" }
  | { kind: "empty" };

interface PhoneLastBarsRecord {
  version: 1;
  pairingGeneration: string;
  rows: Array<{
    account_id: string;
    provider: string;
    code: string;
    percent: number;
    resets_at: string | null;
    observed_at: string;
    stale: true;
  }>;
}

export function writePhoneLastBars(body: unknown): void {
  if (typeof window === "undefined" || readPhonePairMeta() === null) return;
  const pairingGeneration = storedPairingGeneration();
  if (pairingGeneration === null) return;
  const rows = meterRowsOf(body)
    .filter((row) => row.percent !== null)
    .slice(0, PHONE_LAST_BARS_LIMIT)
    .map((row) => ({
      account_id: row.accountId,
      provider: row.provider,
      code: row.code,
      percent: row.percent as number,
      resets_at: row.resetsAt,
      observed_at: row.observedAt,
      stale: true as const,
    }));
  const record: PhoneLastBarsRecord = {
    version: PHONE_LAST_BARS_VERSION,
    pairingGeneration,
    rows,
  };
  try { window.localStorage.setItem(PHONE_LAST_BARS_KEY, JSON.stringify(record)); }
  catch { /* An offline convenience must never block a fresh reading. */ }
}

export function readPhoneLastBars(): { rows: PhoneLastBarsRecord["rows"] } | null {
  if (typeof window === "undefined" || readPhonePairMeta() === null) return null;
  try {
    const raw = window.localStorage.getItem(PHONE_LAST_BARS_KEY);
    if (raw === null) return null;
    const value = record(JSON.parse(raw));
    const revision = storedPairingGeneration();
    if (value?.version !== PHONE_LAST_BARS_VERSION ||
        typeof value.pairingGeneration !== "string" ||
        value.pairingGeneration !== revision ||
        !Array.isArray(value.rows) || value.rows.length > PHONE_LAST_BARS_LIMIT) return null;
    const body = { rows: value.rows };
    const parsed = meterRowsOf(body).filter((row) => row.percent !== null);
    if (parsed.length !== value.rows.length) return null;
    return { rows: value.rows as PhoneLastBarsRecord["rows"] };
  } catch { return null; }
}

/** Read the account's meters through the same-origin route. */
export async function requestPhoneRead(recoveredLabel = "This phone"): Promise<PhoneReadOutcome> {
  if (pairingReplacementPending()) return { kind: "superseded" };
  const pairingGeneration = currentPairingGeneration();
  const current = phoneRequestGuard();
  if (phoneDisabled()) return { kind: "unpaired" };
  const answer = await postJson("/app/pair/api/read");
  const invalidated = phoneRequestInvalidation(current, pairingGeneration);
  if (invalidated !== null) return { kind: invalidated };
  if (answer.status === 401) {
    const body = record(answer.body);
    return body?.error === "no_pair" ? { kind: "unpaired" } : { kind: "empty" };
  }
  if (answer.status === 403) {
    clearPhonePairMeta();
    return { kind: "revoked" };
  }
  if (answer.status !== 200) return { kind: "empty" };
  const body = record(answer.body);
  const fresh = body?.body ?? null;
  if (readPhonePairMeta() === null) {
    writePhonePairMeta({
      label: recoveredLabel,
      expiresAt: Math.floor(Date.now() / 1_000) + PHONE_RENEW_WITHIN_SECONDS + 60,
    });
  }
  writePhoneLastBars(fresh);
  return { kind: "fresh", body: fresh };
}

/** Renew before reading, and recover a missing access cookie without deleting the refresh cookie. */
export async function readCurrentPhoneBars(recoveredLabel = "This phone"): Promise<PhoneReadOutcome> {
  const pairingGeneration = currentPairingGeneration();
  const current = phoneRequestGuard();
  if (phoneDisabled()) return { kind: "unpaired" };
  const meta = readPhonePairMeta();
  if (meta !== null && phonePairNeedsRenewal(meta)) {
    const renewal = await requestPhoneRenewal();
    const invalidated = phoneRequestInvalidation(current, pairingGeneration);
    if (invalidated !== null) return { kind: invalidated };
    if (renewal.kind === "superseded") return renewal;
    if (renewal.kind === "revoked") return renewal;
    if (renewal.kind === "unpaired") return renewal;
    if (renewal.kind === "unavailable") return { kind: "empty" };
  }
  const answer = await requestPhoneRead(recoveredLabel);
  let invalidated = phoneRequestInvalidation(current, pairingGeneration);
  if (invalidated !== null) return { kind: invalidated };
  if (answer.kind === "superseded") return answer;
  if (answer.kind !== "unpaired") return answer;
  const renewal = await requestPhoneRenewal(true);
  invalidated = phoneRequestInvalidation(current, pairingGeneration);
  if (invalidated !== null) return { kind: invalidated };
  if (renewal.kind === "superseded") return renewal;
  if (renewal.kind === "revoked") return renewal;
  if (renewal.kind === "unpaired") return renewal;
  if (renewal.kind === "unavailable") return { kind: meta === null ? "unpaired" : "empty" };
  const retried = await requestPhoneRead(recoveredLabel);
  invalidated = phoneRequestInvalidation(current, pairingGeneration);
  if (invalidated !== null) return { kind: invalidated };
  if (retried.kind === "superseded") return retried;
  return retried.kind === "unpaired" ? { kind: "empty" } : retried;
}
