/**
 * The paired phone's credential pair, and the renewal that keeps it alive.
 *
 * A successful pairing hands the phone two things in one answer: a read token
 * with a 24 hour life, and a refresh credential shown exactly once. They are
 * stored together under one local storage key, because neither means anything
 * without the other: the token reads the meters, the credential mints the next
 * token through pro-service's `phone_renew` action.
 *
 * RENEWAL, NOT REPAIR
 * -------------------
 * `phone_renew` answers even when the read token has already expired, so the
 * page renews on every open once the token is within an hour of its end
 * rather than waiting for a read to fail. The one case renewal cannot fix is
 * a revocation epoch bump on the server: that answers 401, and the only honest
 * thing left is to ask for a fresh scan from the hub.
 *
 * A renewal answer can be lost between the server writing it and the phone
 * reading it: the previous credential is then already spent, and the server
 * accepts it exactly once more inside a five minute grace. `renewPhonePair`
 * takes that second shot itself, so a dropped response is invisible.
 *
 * Nothing here logs, stores or prints a credential anywhere but the one key.
 */

import { readDeviceSnapshots, renewPhoneCredential, type HostedResponse } from "./pro-device";

/** The one local storage key the phone's credential pair lives under. */
export const PHONE_PAIR_STORAGE_KEY = "openlimiter-phone-pair";

/** Renew once the token is this close to its end, rather than at it. */
export const PHONE_RENEW_WITHIN_SECONDS = 3_600;

/** How long the server honours a spent credential, as a bound on the retry. */
export const PHONE_RENEW_GRACE_SECONDS = 300;

export interface PhonePair {
  /** The read scoped token, audience phone. */
  token: string;
  /** Unix seconds. The token is not accepted after this. */
  expiresAt: number;
  /** The single use credential the next renewal carries. */
  refreshCredential: string;
  /** Unix seconds. No renewal is possible after this. */
  refreshExpiresAt: number;
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
 * A delivery or a renewal answer, as the pair this browser stores.
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

/* --------------------------------------------------------------- storage */

/** The stored pair, or null when there is none or it cannot be trusted. */
export function readPhonePair(): PhonePair | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PHONE_PAIR_STORAGE_KEY);
    if (raw === null) return null;
    const row = record(JSON.parse(raw));
    if (row === null) return null;
    return phonePairOf({
      token: row.token,
      refresh_credential: row.refreshCredential,
      expires_at: row.expiresAt,
      refresh_expires_at: row.refreshExpiresAt,
    });
  } catch {
    return null;
  }
}

export function writePhonePair(pair: PhonePair): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PHONE_PAIR_STORAGE_KEY, JSON.stringify(pair));
  } catch {
    /* A browser with storage refused keeps the pair in memory only. */
  }
}

export function clearPhonePair(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(PHONE_PAIR_STORAGE_KEY);
  } catch {
    /* Nothing to clear if storage was never available. */
  }
}

/**
 * Trade a refresh credential for the next read token, deciding what the answer
 * means.
 *
 * The credential is single use and travels only in the body of this call. The
 * server answers a fresh pair even when the old read token has expired, and
 * honours the credential this call replaces once more inside its grace, which
 * is what makes a lost answer recoverable. A revoked epoch answers 401 or 403,
 * the same shape as every other refusal here.
 */
export type RenewOutcome =
  | { kind: "kept"; pair: PhonePair }
  | { kind: "renewed"; pair: PhonePair }
  | { kind: "revoked" }
  | { kind: "unavailable" };

/** Whether the stored pair should be renewed now rather than on its failure. */
export function phonePairNeedsRenewal(
  pair: PhonePair,
  now: number = Date.now(),
): boolean {
  return pair.expiresAt * 1_000 - now <= PHONE_RENEW_WITHIN_SECONDS * 1_000;
}

/**
 * Renew through `phone_renew`, with the one grace retry built in.
 *
 * The first attempt carries the stored credential. An unreachable answer, or
 * one that cannot be parsed, is tried once more with the same credential: the
 * likely story is the response was lost after the server already rotated, and
 * the server honours the previous credential once inside the grace. A second
 * failure is reported as unavailable, and the stored pair is left untouched:
 * it may still read, and the next open tries again.
 */
export async function renewPhonePair(
  pair: PhonePair,
  call: (refreshCredential: string) => Promise<HostedResponse> = renewPhoneCredential,
): Promise<RenewOutcome> {
  const attempted = await renewAttempt(pair, call);
  if (attempted.kind === "renewed" || attempted.kind === "revoked") return attempted;
  /* Only now does the retry make sense: the first answer never arrived or
     never parsed, so the credential may already be rotated server side. */
  return renewAttempt(pair, call);
}

async function renewAttempt(
  pair: PhonePair,
  call: (refreshCredential: string) => Promise<HostedResponse>,
): Promise<RenewOutcome> {
  let response: HostedResponse;
  try {
    response = await call(pair.refreshCredential);
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 401 || response.status === 403) return { kind: "revoked" };
  if (response.status !== 200) return { kind: "unavailable" };
  const next = phonePairOf(response.body);
  return next === null ? { kind: "unavailable" } : { kind: "renewed", pair: next };
}

/* -------------------------------------------------------------- the read */

export type PhoneRead =
  | { kind: "fresh"; body: unknown }
  | { kind: "stale"; body: unknown }
  | { kind: "revoked" }
  | { kind: "empty" };

/**
 * One read of the account's meters, as the pair page sees it.
 *
 * Every failure keeps the last good bars rather than clearing the screen:
 * being offline on a phone is ordinary, and the reader has no way to tell it
 * apart from a service hiccup. The one answer that ends the pairing is 401 or
 * 403 from the read itself, the revocation epoch bump, which is reported as
 * revoked and nothing else.
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
  if (response.status === 401 || response.status === 403) return { kind: "revoked" };
  if (response.status !== 200) return { kind: "empty" };
  return { kind: "fresh", body: response.body };
}

/** Fold a failed read into the state the bars stay in: the last good ones. */
export function stalePhoneRead(body: unknown): PhoneRead {
  return { kind: "stale", body };
}
