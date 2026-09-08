import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/pro";

const PROVIDER_PATTERN = /^[A-Z0-9_]{2,32}$/u;
const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const WINDOW_PATTERN = /^[A-Z0-9_]{2,48}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

/**
 * What the hub reads back, and where it reads it from.
 *
 * The current rows are not selectable by a signed in browser: the sync
 * migration revoked `usage_current` and `usage_samples` from `authenticated`
 * on purpose, so a table this file used to name is both renamed and closed.
 * Everything here goes through the two owner scoped functions instead, which
 * answer for the signed in account and nobody else.
 */
const USAGE_FUNCTION = "read_current_usage_v1";
const API_SPEND_FUNCTION = "read_current_api_spend_v1";

export interface SyncedUsageWindow {
  windowName: string;
  percentage: number;
  resetAt: string | null;
  observedAt: string;
  /** The device said this reading was already past its own freshness window. */
  stale: boolean;
}

export interface SyncedProviderUsage {
  provider: string;
  accountLabel: string;
  windows: SyncedUsageWindow[];
}

export interface SyncedApiSpend {
  provider: string;
  accountLabel: string;
  currency: string;
  amountMinor: number;
  periodStart: string;
  periodEnd: string;
  observedAt: string;
}

export type SyncedUsageResult =
  | { ok: true; providers: SyncedProviderUsage[] }
  | { ok: false; reason: "unconfigured" | "signed_out" | "unavailable" };

export type SyncedApiSpendResult =
  | { ok: true; sources: SyncedApiSpend[] }
  | { ok: false; reason: "unconfigured" | "signed_out" | "unavailable" };

interface UsageRow {
  provider: string;
  account_id: string;
  window_id: string;
  used_percent: number;
  resets_at: string | null;
  observed_at: string;
  stale: boolean;
}

export function createSyncClient(): SupabaseClient | null {
  if (SUPABASE_URL === "" || SUPABASE_ANON_KEY === "") return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

function instantOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function currencyOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (CURRENCY_PATTERN.test(value)) return value;
  const suffix = value.match(/_([A-Z]{3})$/u)?.[1] ?? null;
  return suffix !== null && CURRENCY_PATTERN.test(suffix) ? suffix : null;
}

function utcDate(value: Date): string {
  return [value.getUTCFullYear(), String(value.getUTCMonth() + 1).padStart(2, "0"), String(value.getUTCDate()).padStart(2, "0")].join("-");
}

export function syncedPeriodOf(periodStart: string, periodEnd: string): {
  start: string;
  end: string;
  mode: "through" | "upTo";
} {
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  const midnight = end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0 && end.getUTCMilliseconds() === 0;
  if (midnight) {
    end.setUTCDate(end.getUTCDate() - 1);
  }
  return {
    start: utcDate(start),
    end: utcDate(end),
    mode: midnight ? "through" : "upTo",
  };
}

/**
 * One usage row, or nothing.
 *
 * A row that fails a bound is dropped rather than repaired, exactly as the
 * desktop drops a reading it cannot trust. `window_id` is the window's own
 * name, which is what makes a model scoped window such as `SEVEN_DAY_FABLE` a
 * row of its own beside the plain weekly one rather than a replacement for it.
 */
function rowOf(value: unknown): UsageRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const provider = typeof row.provider === "string" ? row.provider : "";
  const accountId = typeof row.account_id === "string" ? row.account_id : "";
  const windowId = typeof row.window_id === "string" ? row.window_id : "";
  const percentage = Number(row.used_percent);
  const resetsAt = row.resets_at === null || row.resets_at === undefined
    ? null
    : instantOf(row.resets_at);
  const observedAt = instantOf(row.observed_at);
  if (
    !PROVIDER_PATTERN.test(provider) || !ACCOUNT_PATTERN.test(accountId) ||
    !WINDOW_PATTERN.test(windowId) || !Number.isFinite(percentage) || percentage < 0 ||
    percentage > 100 || observedAt === null ||
    (row.resets_at !== null && row.resets_at !== undefined && resetsAt === null)
  ) {
    return null;
  }
  return {
    provider,
    account_id: accountId,
    window_id: windowId,
    used_percent: percentage,
    resets_at: resetsAt,
    observed_at: observedAt,
    stale: row.stale === true,
  };
}

export function groupLatestSyncedUsage(values: unknown[]): SyncedProviderUsage[] {
  const latest = new Map<string, UsageRow>();
  for (const value of values) {
    const row = rowOf(value);
    if (row === null) continue;
    const key = `${row.provider}${row.account_id}${row.window_id}`;
    const previous = latest.get(key);
    if (previous === undefined || Date.parse(row.observed_at) > Date.parse(previous.observed_at)) {
      latest.set(key, row);
    }
  }

  const providers = new Map<string, SyncedProviderUsage>();
  for (const row of latest.values()) {
    const key = `${row.provider}${row.account_id}`;
    const provider = providers.get(key) ?? {
      provider: row.provider,
      accountLabel: row.account_id,
      windows: [],
    };
    provider.windows.push({
      windowName: row.window_id,
      percentage: row.used_percent,
      resetAt: row.resets_at,
      observedAt: row.observed_at,
      stale: row.stale,
    });
    providers.set(key, provider);
  }

  return [...providers.values()]
    .map((provider) => ({
      ...provider,
      windows: provider.windows.sort((left, right) =>
        left.windowName.localeCompare(right.windowName)
      ),
    }))
    .sort((left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.accountLabel.localeCompare(right.accountLabel)
    );
}

/**
 * One spend row, or nothing.
 *
 * Money stays money. The amount arrives in the currency's minor unit as an
 * integer, because a dollar figure that went through a float on the way to a
 * screen is a dollar figure nobody can reconcile with an invoice.
 */
export function apiSpendOf(value: unknown): SyncedApiSpend | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const provider = typeof row.provider === "string" ? row.provider : "";
  const accountId = typeof row.account_id === "string" ? row.account_id : "";
  const currency = currencyOf(row.currency);
  if ((typeof row.amount_minor !== "number" && typeof row.amount_minor !== "string") ||
      (typeof row.amount_minor === "string" && row.amount_minor.trim() === "")) return null;
  const amountMinor = Number(row.amount_minor);
  const periodStart = instantOf(row.period_start);
  const periodEnd = instantOf(row.period_end);
  const observedAt = instantOf(row.observed_at);
  if (
    !PROVIDER_PATTERN.test(provider) || !ACCOUNT_PATTERN.test(accountId) ||
    currency === null || !Number.isSafeInteger(amountMinor) || amountMinor < 0 ||
    periodStart === null || periodEnd === null || observedAt === null ||
    Date.parse(periodStart) >= Date.parse(periodEnd)
  ) {
    return null;
  }
  return {
    provider,
    accountLabel: accountId,
    currency,
    amountMinor,
    periodStart,
    periodEnd,
    observedAt,
  };
}

export function readableApiSpend(values: unknown[]): SyncedApiSpend[] {
  return values
    .map(apiSpendOf)
    .filter((row): row is SyncedApiSpend => row !== null)
    .sort((left, right) =>
      left.provider.localeCompare(right.provider) ||
      left.accountLabel.localeCompare(right.accountLabel)
    );
}

async function signedIn(client: SupabaseClient): Promise<"yes" | "no" | "unknown"> {
  const session = await client.auth.getSession();
  if (session.error !== null) return "unknown";
  return session.data.session === null ? "no" : "yes";
}

export async function readSyncedUsage(
  client: SupabaseClient | null,
): Promise<SyncedUsageResult> {
  if (client === null) return { ok: false, reason: "unconfigured" };
  const state = await signedIn(client);
  if (state === "unknown") return { ok: false, reason: "unavailable" };
  if (state === "no") return { ok: false, reason: "signed_out" };

  const result = await client.rpc(USAGE_FUNCTION);
  if (result.error !== null || !Array.isArray(result.data)) {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, providers: groupLatestSyncedUsage(result.data) };
}

export async function readSyncedApiSpend(
  client: SupabaseClient | null,
): Promise<SyncedApiSpendResult> {
  if (client === null) return { ok: false, reason: "unconfigured" };
  const state = await signedIn(client);
  if (state === "unknown") return { ok: false, reason: "unavailable" };
  if (state === "no") return { ok: false, reason: "signed_out" };

  const result = await client.rpc(API_SPEND_FUNCTION);
  if (result.error !== null || !Array.isArray(result.data)) {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, sources: readableApiSpend(result.data) };
}
