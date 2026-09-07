import type { SupabaseClient } from "@supabase/supabase-js";
import { callProFunction, entitlementOf, type ProEntitlement } from "./pro";

/**
 * The trial, and the offer that follows it.
 *
 * THERE IS EXACTLY ONE DOOR INTO A TRIAL
 * --------------------------------------
 * It is `startProTrial`, and it is called from one place: the wizard's last
 * action. Nothing else in this application starts a trial, reading an
 * entitlement never starts one, and opening checkout never starts one, because
 * a trial that can begin as a side effect of looking at a page is a trial
 * nobody chose and a thirty day clock nobody was told about. The server holds
 * the same rule from its side: a second call returns the state that already
 * exists rather than a second trial, and an account that has ever had a trial
 * or a paid plan is refused.
 *
 * WHAT THE WIZARD STAGES
 * ----------------------
 * Thresholds, the reset switch and, when the browser grants it, a push
 * subscription. All of it is held in the wizard's own state and travels in the
 * one call that starts the trial, so somebody who turns push on and then walks
 * away has given the server nothing at all.
 *
 * THE COUNTDOWN IS READ, NEVER COMPUTED
 * -------------------------------------
 * `offer_ends_at` comes from the server and is the only clock the offer trusts.
 * The functions at the bottom turn that instant into days, hours and minutes
 * for a reader, and they answer null the moment it has passed, so a browser
 * with a wrong clock can show a stale countdown and still never mint a
 * discounted session: the server checks the window again before it does.
 */

/** The thresholds a trial opens with, and the only ones the server accepts. */
export const TRIAL_ALERT_THRESHOLDS = [60, 80, 90] as const;

/** The offer `create-checkout` knows by name. There is one, and this is it. */
export const TRIAL_END_OFFER = "trial_end_annual";

export interface TrialAlertPreferences {
  /** A subset of the three thresholds above, in ascending order. */
  thresholds: number[];
  /** Whether a window resetting is worth a message of its own. */
  reset: boolean;
}

export interface TrialPreferences {
  alerts: TrialAlertPreferences;
  /** Only present when this browser granted the permission and subscribed. */
  push?: PushSubscriptionJSON;
}

/**
 * Why a trial or an offer did not happen.
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
 * switch the server puts in front of the trial and the offer, which is a
 * temporary state and says so rather than reading as a fault.
 */
export function trialFailureForStatus(status: number | null): TrialFailure {
  if (status === 401) return "unauthenticated";
  if (status === 409) return "alreadyUsed";
  if (status === 429) return "rateLimited";
  if (status === 503) return "switchedOff";
  return "unavailable";
}

function preferenceBody(preferences: TrialPreferences): Record<string, unknown> {
  const alerts = {
    thresholds: [...preferences.alerts.thresholds].sort((left, right) => left - right),
    reset: preferences.alerts.reset,
  };
  return preferences.push === undefined
    ? { alerts }
    : { alerts, push: preferences.push };
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
  preferences: TrialPreferences,
): Promise<TrialResult<ProEntitlement | null>> {
  const result = await callProFunction<Record<string, unknown>>(client, "pro-service", {
    action: "start_trial",
    preferences: preferenceBody(preferences),
  });
  if (!result.ok) return { ok: false, reason: trialFailureForStatus(result.status) };
  return { ok: true, value: entitlementOf(result.value.entitlement) };
}

/**
 * A Stripe Checkout session for the discounted first year. The caller redirects.
 *
 * The interval is not a parameter. This offer is annual by definition, the
 * server forces the year interval anyway, and a client that could ask for a
 * discounted month would only ever be asking for a refusal.
 */
export async function startOfferCheckout(client: SupabaseClient): Promise<TrialResult<string>> {
  const result = await callProFunction<Record<string, unknown>>(client, "create-checkout", {
    interval: "year",
    offer: TRIAL_END_OFFER,
  });
  if (!result.ok) return { ok: false, reason: trialFailureForStatus(result.status) };
  const url = result.value.url;
  return typeof url === "string" && url !== ""
    ? { ok: true, value: url }
    : { ok: false, reason: "unavailable" };
}

/* ------------------------------------------------------------ pure decisions */

/** How long an offer has left, broken into the three units a person reads. */
export interface OfferCountdown {
  days: number;
  hours: number;
  minutes: number;
  /** The whole remainder in milliseconds, for a caller that wants to compare. */
  remaining: number;
}

/**
 * The offer's remaining time, or null once there is none.
 *
 * Null is the answer to every question that is not "there is time left": no
 * date, an unreadable date, and a date that has passed. The card reads that
 * one null and falls back to the ordinary prices, so the closed state is
 * never a second condition somebody can forget to write.
 */
export function offerCountdown(
  offerEndsAt: string | null,
  now: number = Date.now(),
): OfferCountdown | null {
  if (offerEndsAt === null) return null;
  const ends = Date.parse(offerEndsAt);
  if (!Number.isFinite(ends)) return null;
  const remaining = ends - now;
  if (remaining <= 0) return null;
  const minutes = Math.floor(remaining / 60_000);
  return {
    days: Math.floor(minutes / 1440),
    hours: Math.floor((minutes % 1440) / 60),
    minutes: minutes % 60,
    remaining,
  };
}

/** Whether the discounted annual session may still be asked for. */
export function offerOpen(offerEndsAt: string | null, now: number = Date.now()): boolean {
  return offerCountdown(offerEndsAt, now) !== null;
}

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
