import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/pro";

const PROVIDER_PATTERN = /^[A-Z0-9_]{2,32}$/u;
const ACCOUNT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const WINDOW_PATTERN = /^[A-Z0-9_]{2,48}$/u;

export interface SyncedUsageWindow {
  windowName: string;
  percentage: number;
  resetAt: string | null;
  observedAt: string;
}

export interface SyncedProviderUsage {
  provider: string;
  accountLabel: string;
  windows: SyncedUsageWindow[];
}

export type SyncedUsageResult =
  | { ok: true; providers: SyncedProviderUsage[] }
  | { ok: false; reason: "unconfigured" | "signed_out" | "unavailable" };

interface DatabaseRow {
  provider: string;
  account_label: string;
  window_name: string;
  usage_percent: number | string;
  reset_at: string | null;
  observed_at: string;
}

export function createSyncClient(): SupabaseClient | null {
  if (SUPABASE_URL === "" || SUPABASE_ANON_KEY === "") return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

function rowOf(value: unknown): DatabaseRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const provider = typeof row.provider === "string" ? row.provider : "";
  const accountLabel = typeof row.account_label === "string" ? row.account_label : "";
  const windowName = typeof row.window_name === "string" ? row.window_name : "";
  const percentage = Number(row.usage_percent);
  const resetAt = row.reset_at === null || typeof row.reset_at === "string" ? row.reset_at : null;
  const observedAt = typeof row.observed_at === "string" ? row.observed_at : "";
  if (
    !PROVIDER_PATTERN.test(provider) || !ACCOUNT_PATTERN.test(accountLabel) ||
    !WINDOW_PATTERN.test(windowName) || !Number.isFinite(percentage) || percentage < 0 ||
    percentage > 100 || !Number.isFinite(Date.parse(observedAt)) ||
    (resetAt !== null && !Number.isFinite(Date.parse(resetAt)))
  ) {
    return null;
  }
  return {
    provider,
    account_label: accountLabel,
    window_name: windowName,
    usage_percent: percentage,
    reset_at: resetAt === null ? null : new Date(Date.parse(resetAt)).toISOString(),
    observed_at: new Date(Date.parse(observedAt)).toISOString(),
  };
}

export function groupLatestSyncedUsage(values: unknown[]): SyncedProviderUsage[] {
  const latest = new Map<string, DatabaseRow>();
  for (const value of values) {
    const row = rowOf(value);
    if (row === null) continue;
    const key = `${row.provider}\u001f${row.account_label}\u001f${row.window_name}`;
    const previous = latest.get(key);
    if (previous === undefined || Date.parse(row.observed_at) > Date.parse(previous.observed_at)) {
      latest.set(key, row);
    }
  }

  const providers = new Map<string, SyncedProviderUsage>();
  for (const row of latest.values()) {
    const key = `${row.provider}\u001f${row.account_label}`;
    const provider = providers.get(key) ?? {
      provider: row.provider,
      accountLabel: row.account_label,
      windows: [],
    };
    provider.windows.push({
      windowName: row.window_name,
      percentage: Number(row.usage_percent),
      resetAt: row.reset_at,
      observedAt: row.observed_at,
    });
    providers.set(key, provider);
  }

  return [...providers.values()]
    .map((provider) => ({
      ...provider,
      windows: provider.windows.sort((left, right) => left.windowName.localeCompare(right.windowName)),
    }))
    .sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.accountLabel.localeCompare(right.accountLabel)
    );
}

export async function readSyncedUsage(
  client: SupabaseClient | null,
): Promise<SyncedUsageResult> {
  if (client === null) return { ok: false, reason: "unconfigured" };
  const session = await client.auth.getSession();
  if (session.error !== null) return { ok: false, reason: "unavailable" };
  if (session.data.session === null) return { ok: false, reason: "signed_out" };

  const result = await client
    .from("usage_snapshots_current")
    .select("provider,account_label,window_name,usage_percent,reset_at,observed_at")
    .order("provider", { ascending: true })
    .order("account_label", { ascending: true })
    .order("window_name", { ascending: true });
  if (result.error !== null) return { ok: false, reason: "unavailable" };
  return { ok: true, providers: groupLatestSyncedUsage(result.data) };
}
