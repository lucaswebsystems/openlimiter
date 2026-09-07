import type { SupabaseClient } from "@supabase/supabase-js";
import { callProFunction } from "./pro";

/**
 * The cloud metering contract, as the hub calls it.
 *
 * `cloud-meter` is a Pro server function, built alongside this client: a
 * signed in reader's own JWT is the only credential this module ever sends,
 * the key being metered travels once in the body of a `store` call and never
 * again, and every answer after that names the key by its id and its label
 * rather than repeating it. Four actions, one function, the same shape
 * `pro-service` already uses elsewhere in this codebase.
 *
 * A 403 means the account is not entitled (`{ error: "feature", feature:
 * "api_spend" }`, the same "buy the feature" shape every other Pro gate in
 * this app answers with); a 503 means the surface itself is switched off
 * server side. Both are told apart from an ordinary failure because the
 * Configuration panel draws a different card for each: a trial offer for the
 * first, "try again later" for the second, and a plain retry for anything
 * else.
 */

/** Every provider the cloud can hold a key for and poll on its own. */
export const CLOUD_METER_PROVIDERS = [
  "anthropic_admin",
  "openai_admin",
  "xai",
  "moonshot",
  "openrouter",
] as const;

export type CloudMeterProvider = (typeof CLOUD_METER_PROVIDERS)[number];

/** The four states a stored key's last poll can report. */
export type CloudMeterStatus = "ok" | "error" | "pending" | "unknown";

export interface CloudMeterKey {
  id: string;
  provider: CloudMeterProvider;
  label: string;
  lastStatus: CloudMeterStatus;
  /** The most recent spend the cloud poll observed, when it has polled at least once. */
  amount: number | null;
  currency: string | null;
}

export type CloudMeterFailure = "needsPro" | "disabled" | "unavailable";

export type CloudMeterResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: CloudMeterFailure };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function providerOf(value: unknown): CloudMeterProvider | null {
  return typeof value === "string" && (CLOUD_METER_PROVIDERS as readonly string[]).includes(value)
    ? (value as CloudMeterProvider)
    : null;
}

function statusOf(value: unknown): CloudMeterStatus {
  return value === "ok" || value === "error" || value === "pending" ? value : "unknown";
}

function amount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** One stored key row, or null when it does not satisfy the contract. */
export function cloudMeterKeyOf(value: unknown): CloudMeterKey | null {
  const row = record(value);
  if (row === null) return null;
  const id = typeof row.id === "string" ? row.id : "";
  const provider = providerOf(row.provider);
  const label = typeof row.label === "string" ? row.label : "";
  if (id === "" || provider === null || label === "") return null;
  const currency = typeof row.currency === "string" ? row.currency : null;
  const parsedAmount = amount(row.amount);
  return {
    id,
    provider,
    label,
    lastStatus: statusOf(row.last_status),
    amount: currency === null ? null : parsedAmount,
    currency: parsedAmount === null ? null : currency,
  };
}

/** Every row a `list` answer carries that survives validation. */
export function cloudMeterKeysOf(value: unknown): CloudMeterKey[] {
  const row = record(value);
  const rows = Array.isArray(row?.rows)
    ? row.rows
    : Array.isArray(value)
      ? value
      : [];
  const parsed: CloudMeterKey[] = [];
  for (const entry of rows) {
    const key = cloudMeterKeyOf(entry);
    if (key !== null) parsed.push(key);
  }
  return parsed;
}

function failureOf(status: number | null): CloudMeterFailure {
  if (status === 403) return "needsPro";
  if (status === 503) return "disabled";
  return "unavailable";
}

async function callCloudMeter<T>(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<CloudMeterResult<T>> {
  const result = await callProFunction<T>(client, "cloud-meter", body);
  return result.ok ? result : { ok: false, reason: failureOf(result.status) };
}

export interface StoreCloudKeyInput {
  provider: CloudMeterProvider;
  label: string;
  /** Sent once, in this body, and never read back from any later answer. */
  key: string;
}

/**
 * Send a key to be metered from the cloud.
 *
 * The key lives in this one request body and nowhere else in this module: the
 * row this resolves to never carries it, and no caller of this function is
 * allowed to keep the input around after it returns. See CloudKeyForm, which
 * clears its own field on every outcome, success included.
 */
export async function storeCloudKey(
  client: SupabaseClient,
  input: StoreCloudKeyInput,
): Promise<CloudMeterResult<CloudMeterKey>> {
  const result = await callCloudMeter<unknown>(client, {
    action: "store",
    provider: input.provider,
    label: input.label,
    key: input.key,
  });
  if (!result.ok) return result;
  const row = cloudMeterKeyOf(result.value);
  return row === null ? { ok: false, reason: "unavailable" } : { ok: true, value: row };
}

export async function listCloudKeys(client: SupabaseClient): Promise<CloudMeterResult<CloudMeterKey[]>> {
  const result = await callCloudMeter<unknown>(client, { action: "list" });
  return result.ok ? { ok: true, value: cloudMeterKeysOf(result.value) } : result;
}

export async function deleteCloudKey(
  client: SupabaseClient,
  id: string,
): Promise<CloudMeterResult<null>> {
  const result = await callCloudMeter<unknown>(client, { action: "delete", id });
  return result.ok ? { ok: true, value: null } : result;
}

export async function pollCloudKeyNow(
  client: SupabaseClient,
  id: string,
): Promise<CloudMeterResult<CloudMeterKey>> {
  const result = await callCloudMeter<unknown>(client, { action: "poll_now", id });
  if (!result.ok) return result;
  const row = cloudMeterKeyOf(result.value);
  return row === null ? { ok: false, reason: "unavailable" } : { ok: true, value: row };
}
