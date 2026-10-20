import type { SupabaseClient } from "@supabase/supabase-js";
import { callProFunction, entitlementOf, type ProEntitlement } from "./pro";

/**
 * The trial, and the checkout address it may lead to.
 *
 * THERE IS EXACTLY ONE DOOR INTO A TRIAL
 * --------------------------------------
 * It is `startProTrial`, called by explicit start controls in the header and
 * the wizard. Reading an entitlement never starts one, and opening checkout
 * never starts one, because
 * a trial that can begin as a side effect of looking at a page is a trial
 * nobody chose and a thirty day clock nobody was told about. The server holds
 * the same rule from its side: a second call returns the state that already
 * exists rather than a second trial, and an account that has ever had a trial
 * or a paid plan is refused.
 *
 * WHAT THE WIZARD SENDS
 * ----------------------
 * The server applies the complete recommended profile. The only optional value
 * this client can add is a push subscription when the browser grants it.
 *
 * THERE IS NO DISCOUNTED FIRST YEAR
 * ---------------------------------
 * A plan that ends is offered the two locked prices, a month and a year, the
 * same as anywhere else; the trial end offer the server can still describe is
 * never drawn and never asked for.
 */

export interface TrialPreferences {
  /** Only present when this browser granted the permission and subscribed. */
  push?: PushSubscriptionJSON;
}

/**
 * Why a trial or a checkout did not happen.
 *
 * Five reasons rather than one, because each is a different sentence to a
 * reader: sign in again, you have already had this, slow down, the feature is
 * switched off right now, and something else went wrong.
 */
export type TrialFailure =
  | "unauthenticated"
  | "alreadyUsed"
  | "rateLimited"
  | "switchedOff"
  | "unavailable";

export type TrialResult<T> = { ok: true; value: T } | { ok: false; reason: TrialFailure };

/**
 * What a status code means on the trial path.
 *
 * 409 is the refusal that matters: this account has had its trial, or is
 * paying, and either way the answer is not "try again". 503 is the kill
 * switch the server puts in front of the trial and checkout, which is a
 * temporary state and says so rather than reading as a fault.
 */
export function trialFailureForStatus(status: number | null): TrialFailure {
  if (status === 401) return "unauthenticated";
  if (status === 409) return "alreadyUsed";
  if (status === 429) return "rateLimited";
  if (status === 503) return "switchedOff";
  return "unavailable";
}

/** The one local storage key this browser's own hub device id lives under. */
export const HUB_DEVICE_ID_KEY = "openlimiter-hub-device-id";

function randomDeviceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A stable id for this browser, sent alongside a push subscription so the
 * server can tell one browser's registration from another's.
 *
 * A browser tab starting a trial holds no device grant yet, so there is no
 * registered device id to reuse the way `registerProPush` reuses one. What
 * this reads back instead is whatever this same browser already generated for
 * an earlier push or pairing attempt, kept under its own hub key; a browser
 * with none gets one made once, stored under that key, and read back
 * unchanged on every later call.
 */
export function browserDeviceId(): string {
  if (typeof window === "undefined") return randomDeviceId();
  try {
    const existing = window.localStorage.getItem(HUB_DEVICE_ID_KEY);
    if (existing !== null && existing !== "") return existing;
    const generated = randomDeviceId();
    window.localStorage.setItem(HUB_DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return randomDeviceId();
  }
}

function preferenceBody(preferences: TrialPreferences): Record<string, unknown> {
  return preferences.push === undefined
    ? {}
    : { push: { ...preferences.push, device_id: browserDeviceId() } };
}

/**
 * Start the thirty day trial, once, with everything the wizard staged.
 *
 * The entitlement that comes back is the refreshed one, so the surface that
 * called this can draw the new state without asking again and without a
 * reload. A call that succeeds but carries no readable entitlement is still a
 * success: the trial exists, and the next read will find it.
 */
export async function startProTrial(
  client: SupabaseClient,
  preferences: TrialPreferences = {},
): Promise<TrialResult<ProEntitlement | null>> {
  const body: Record<string, unknown> = { action: "start_trial" };
  if (preferences.push !== undefined) body.preferences = preferenceBody(preferences);
  const result = await callProFunction<Record<string, unknown>>(client, "pro-service", body);
  if (!result.ok) return { ok: false, reason: trialFailureForStatus(result.status) };
  /* A 409 is the ordinary path (`result.ok` is false, above), but this guards
     the same refusal delivered as a 200 body: `{ error: "trial_already_used",
     entitlement }`. Either way this is never a success, and the wizard is
     never allowed to read it as one. */
  if (result.value.error === "trial_already_used") {
    return { ok: false, reason: "alreadyUsed" };
  }
  return { ok: true, value: entitlementOf(result.value.entitlement) };
}

/**
 * Accept only an https URL whose host is checkout.stripe.com before redirecting.
 */
export function isAllowedCheckoutUrl(url: unknown): boolean {
  if (typeof url !== "string" || url === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === "checkout.stripe.com";
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ pure decisions */

/**
 * Whether a surface offers to start a trial.
 *
 * Only an account with no entitlement at all. A trial that is running does not
 * need starting, a paid plan does not want it, and an account whose trial has
 * ended is offered the price instead, because the server would refuse a second
 * trial and a button that can only fail is worse than no button.
 */
export function offersTrial(state: string): boolean {
  return state === "none";
}

/** Whether a surface is locked behind Pro and should draw the lock card. */
export function locksPro(state: string): boolean {
  return state === "expired";
}
