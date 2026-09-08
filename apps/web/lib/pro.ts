import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanCliCode, validateCliCode } from "./cli-login";

/**
 * The Pro account layer, as the website talks to it.
 *
 * Every call here goes to one of the hosted functions the Pro server publishes,
 * with the exact request shape that server parses: `entitlement` for the plan
 * summary and the device list, `create-checkout` for a Stripe session,
 * `customer-portal` for billing management. Nothing in this module invents a
 * state, and nothing in it starts a trial: a trial has exactly one door, the
 * wizard in lib/pro-trial.ts, and everything here only reads what came back.
 *
 * The pure functions at the bottom carry every decision the portal makes about
 * what a plan means, so those decisions can be tested without a network.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const SUPABASE_URL: string = supabaseUrl ?? "";
export const SUPABASE_ANON_KEY: string = supabaseAnonKey ?? "";

export const proConfigurationReady: boolean =
  SUPABASE_URL.length > 0 && SUPABASE_ANON_KEY.length > 0;
export const proRailsEnabled: boolean =
  process.env.NEXT_PUBLIC_PRO_ENABLED === "true" && proConfigurationReady;

/** Every plan state the entitlement table can hold, mirrored from the server. */
export const PRO_PLAN_STATES = [
  "trialing",
  "active",
  "past_due",
  "comped",
  "canceled",
  "refunded",
  "expired",
  "deleted",
  "revoked",
] as const;

export type ProPlanState = (typeof PRO_PLAN_STATES)[number];

/** Every entitlement feature the server can grant. */
export const PRO_FEATURES = [
  "alerts",
  "history",
  "api_spend_beta",
  "multi_account",
  "routing",
  "theme_preset",
] as const;

export type ProFeature = (typeof PRO_FEATURES)[number];

/** The two billing intervals `create-checkout` accepts, spelled its way. */
export type ProBillingInterval = "month" | "year";

export interface ProEntitlement {
  planState: ProPlanState;
  features: ProFeature[];
  trialEndsAt: string | null;
  /**
   * When the discounted annual offer closes, or null when there is no offer.
   *
   * It is the server's own clock and the only one the product trusts. The
   * browser never computes it, never extends it, and never draws an offer
   * without it.
   */
  offerEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pastDueUntil: string | null;
  activeDeviceCount: number;
  deviceCap: number;
}

export interface ProDevice {
  deviceId: string;
  label: string;
  createdAt: string | null;
  lastSeenAt: string | null;
  isCurrent: boolean;
  revoked: boolean;
}

export interface ProAccount {
  /** Null until the server has written an entitlement row for this account. */
  entitlement: ProEntitlement | null;
  devices: ProDevice[];
}

/**
 * Why a call did not produce a value.
 *
 * Four reasons rather than one string, because the portal shows a different
 * designed state for each: a session that has gone, a plan that is already
 * paid for, a limit the reader has to wait out, and everything else.
 */
export type ProFailure = "unauthenticated" | "alreadySubscribed" | "rateLimited" | "unavailable";

export type ProResult<T> = { ok: true; value: T } | { ok: false; reason: ProFailure };

function statusOf(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const context = (error as Record<string, unknown>).context;
  if (context === null || typeof context !== "object") return null;
  const status = Number((context as Record<string, unknown>).status);
  return Number.isFinite(status) ? status : null;
}

export function failureForStatus(status: number | null): ProFailure {
  if (status === 401) return "unauthenticated";
  if (status === 409) return "alreadySubscribed";
  if (status === 429) return "rateLimited";
  return "unavailable";
}

/**
 * One call to a hosted function, answered with the status rather than a verdict.
 *
 * The trial and the offer classify a refusal differently from the portal: a
 * 409 is "you already had your trial" on one path and "you are already paying"
 * on another, and a 503 is a kill switch rather than a broken service. So the
 * transport hands back the number and each caller decides what it means,
 * instead of two modules each holding their own copy of this function.
 */
export async function callProFunction<T>(
  client: SupabaseClient,
  fn: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; value: T } | { ok: false; status: number | null }> {
  try {
    const response = await client.functions.invoke<T>(fn, { body });
    if (response.error !== null || response.data === null || response.data === undefined) {
      return { ok: false, status: statusOf(response.error) };
    }
    return { ok: true, value: response.data };
  } catch {
    return { ok: false, status: null };
  }
}

async function call<T>(
  client: SupabaseClient,
  fn: string,
  body: Record<string, unknown>,
): Promise<ProResult<T>> {
  const result = await callProFunction<T>(client, fn, body);
  return result.ok ? result : { ok: false, reason: failureForStatus(result.status) };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function planStateOf(value: unknown): ProPlanState | null {
  return typeof value === "string" && (PRO_PLAN_STATES as readonly string[]).includes(value)
    ? (value as ProPlanState)
    : null;
}

/**
 * The plan the payload names, whichever of the two words it uses.
 *
 * The trial and offer contract spells this field `status` and the four values
 * it can hold are `active`, `trialing`, `expired` and `none`; the entitlement
 * table has always spelled it `plan_state` and carries five more. They are the
 * same field, so both are read here and `none` is what it says it is: no row,
 * which is exactly the state a fresh account is in before it starts a trial.
 */
function planStateFrom(row: Record<string, unknown>): ProPlanState | null {
  const named = planStateOf(row.plan_state);
  if (named !== null) return named;
  if (row.status === "none") return null;
  return planStateOf(row.status);
}

export function entitlementOf(value: unknown): ProEntitlement | null {
  const row = record(value);
  if (row === null) return null;
  const planState = planStateFrom(row);
  if (planState === null) return null;
  const features = Array.isArray(row.features)
    ? row.features.filter((item): item is ProFeature =>
        typeof item === "string" && (PRO_FEATURES as readonly string[]).includes(item),
      )
    : [];
  const cap = Number(row.device_cap);
  const active = Number(row.active_device_count);
  return {
    planState,
    features,
    trialEndsAt: text(row.trial_ends_at),
    offerEndsAt: text(row.offer_ends_at),
    currentPeriodEnd: text(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end === true,
    pastDueUntil: text(row.past_due_until),
    activeDeviceCount: Number.isFinite(active) ? active : 0,
    deviceCap: Number.isFinite(cap) && cap > 0 ? cap : 5,
  };
}

export function devicesOf(value: unknown): ProDevice[] {
  if (!Array.isArray(value)) return [];
  const devices: ProDevice[] = [];
  for (const item of value) {
    const row = record(item);
    const deviceId = text(row?.device_id);
    if (row === null || deviceId === null) continue;
    devices.push({
      deviceId,
      label: text(row.label) ?? deviceId,
      createdAt: text(row.created_at),
      lastSeenAt: text(row.last_seen_at),
      isCurrent: row.is_current === true,
      revoked: row.revoked === true,
    });
  }
  return devices;
}

/** The plan summary and the device list, in one call to `entitlement`. */
export async function readProAccount(client: SupabaseClient): Promise<ProResult<ProAccount>> {
  const result = await call<Record<string, unknown>>(client, "entitlement", { action: "status" });
  if (!result.ok) return result;
  return {
    ok: true,
    value: {
      entitlement: entitlementOf(result.value.entitlement),
      devices: devicesOf(result.value.devices),
    },
  };
}

export interface ProExpiredSummary {
  alertCount: number;
  phonePaired: boolean;
  additionalAccountCount: number;
  hostedContextEnabled: boolean;
}

function count(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function expiredProSummaryOf(value: unknown): ProExpiredSummary | null {
  const row = record(value);
  if (row === null) return null;
  const alertCount = count(row.alert_count);
  const additionalAccountCount = count(row.additional_account_count);
  if (
    alertCount === null ||
    additionalAccountCount === null ||
    typeof row.phone_paired !== "boolean" ||
    typeof row.hosted_context_enabled !== "boolean"
  ) return null;
  return {
    alertCount,
    phonePaired: row.phone_paired,
    additionalAccountCount,
    hostedContextEnabled: row.hosted_context_enabled,
  };
}

export async function readExpiredProSummary(
  client: SupabaseClient,
): Promise<ProResult<ProExpiredSummary>> {
  const result = await callProFunction<Record<string, unknown>>(
    client,
    "pro-service",
    { action: "read_expired_pro_summary" },
  );
  if (!result.ok) return { ok: false, reason: failureForStatus(result.status) };
  const summary = expiredProSummaryOf(result.value);
  return summary === null
    ? { ok: false, reason: "unavailable" }
    : { ok: true, value: summary };
}

/** A Stripe Checkout session for one interval. The caller redirects to `url`. */
export async function startProCheckout(
  client: SupabaseClient,
  interval: ProBillingInterval,
): Promise<ProResult<string>> {
  const result = await call<Record<string, unknown>>(client, "create-checkout", { interval });
  if (!result.ok) return result;
  const url = text(result.value.url);
  return url === null ? { ok: false, reason: "unavailable" } : { ok: true, value: url };
}

/** A Stripe Customer Portal session. The caller redirects to `url`. */
export async function openProBilling(client: SupabaseClient): Promise<ProResult<string>> {
  const result = await call<Record<string, unknown>>(client, "customer-portal", {
    action: "manage",
  });
  if (!result.ok) return result;
  const url = text(result.value.url);
  return url === null ? { ok: false, reason: "unavailable" } : { ok: true, value: url };
}

/** Revoke one device grant. The device's next hosted read returns 401. */
export async function revokeProDevice(
  client: SupabaseClient,
  deviceId: string,
): Promise<ProResult<boolean>> {
  const result = await call<Record<string, unknown>>(client, "entitlement", {
    action: "revoke",
    device_id: deviceId,
  });
  return result.ok ? { ok: true, value: result.value.revoked === true } : result;
}

/**
 * Where a sign in comes back to.
 *
 * The origin and the path of the page that started it, and nothing else. It
 * used to be the current address with everything after a question mark cut
 * off, which reads as the same thing and is not: a fragment survives that cut,
 * so `/pro#anything` would have been handed to the identity provider as the
 * address to return to and would have come back attached to the session. A
 * fragment never reaches a server, so nothing upstream would ever have seen it
 * either.
 *
 * Building the URL out of the two parts that are the page removes the question
 * entirely. There is no query to strip, no fragment to forget, and no crafted
 * link that can steer where a completed sign in lands.
 */
function safeRedirectPath(pathname: string): string {
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(pathname)
  ) {
    return "/app";
  }
  return pathname;
}

export function authRedirectUrl(
  pathname: string = window.location.pathname,
  search: string = window.location.search,
): string {
  const origin = window.location.origin;
  const url = new URL(origin);
  url.pathname = safeRedirectPath(pathname);
  if (url.origin !== origin) return `${origin}/app`;
  const params = new URLSearchParams(search);
  const rawCode = params.get("code");
  const code = rawCode === null ? "" : cleanCliCode(rawCode);
  const boundedCode = code.length <= 64 ? code : "";
  if (url.pathname === "/app/cli" && validateCliCode(boundedCode).valid) {
    url.searchParams.set("code", boundedCode);
  }
  if (url.pathname === "/app" && params.get("trial") === "1") url.searchParams.set("trial", "1");
  return url.href;
}

/* ------------------------------------------------------------ pure decisions */

/**
 * Which designed state the portal shows for a plan.
 *
 * `none` is the state before the server has written anything, which is what a
 * brand new account looks like for the moment between signing in and the trial
 * row appearing. It never means the client should start a trial.
 */
export type ProAccessState = "none" | "trial" | "active" | "pastDue" | "expired";

export function proAccessState(
  entitlement: ProEntitlement | null,
  now: number = Date.now(),
): ProAccessState {
  if (entitlement === null) return "none";
  const { planState } = entitlement;
  if (planState === "trialing") {
    const ends = entitlement.trialEndsAt === null ? NaN : Date.parse(entitlement.trialEndsAt);
    return Number.isFinite(ends) && ends > now ? "trial" : "expired";
  }
  if (planState === "comped") return "active";
  if (planState === "active") {
    const ends =
      entitlement.currentPeriodEnd === null ? NaN : Date.parse(entitlement.currentPeriodEnd);
    return !Number.isFinite(ends) || ends > now ? "active" : "expired";
  }
  if (planState === "past_due") {
    const until = entitlement.pastDueUntil === null ? NaN : Date.parse(entitlement.pastDueUntil);
    return Number.isFinite(until) && until > now ? "pastDue" : "expired";
  }
  return "expired";
}

/**
 * Whole days left in a trial, rounded up, so the last partial day still counts
 * as a day. Null when the plan is not a trial or the date is unreadable.
 */
export function proTrialDaysLeft(
  entitlement: ProEntitlement | null,
  now: number = Date.now(),
): number | null {
  if (entitlement === null || entitlement.trialEndsAt === null) return null;
  const ends = Date.parse(entitlement.trialEndsAt);
  if (!Number.isFinite(ends) || ends <= now) return null;
  return Math.max(1, Math.ceil((ends - now) / 86_400_000));
}

/** Whether the portal offers checkout at all for this plan. */
export function proCanUpgrade(state: ProAccessState): boolean {
  return state === "none" || state === "trial" || state === "expired";
}

/** Whether the portal offers the billing portal for this plan. */
export function proCanManageBilling(state: ProAccessState): boolean {
  return state === "active" || state === "pastDue";
}

/** What a checkout return says, read from a location search string. */
export type ProCheckoutOutcome = "success" | "cancel" | null;

export function proCheckoutOutcome(search: string): ProCheckoutOutcome {
  const value = new URLSearchParams(search).get("checkout");
  return value === "success" || value === "cancel" ? value : null;
}
