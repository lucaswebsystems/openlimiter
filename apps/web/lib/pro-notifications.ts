import type { SupabaseClient } from "@supabase/supabase-js";
import { failureForStatus, type ProFailure } from "./pro";

/**
 * Alert preferences, as the Pro server actually publishes them.
 *
 * Every alert OpenLimiter sends is a Pro alert: a desktop toast, an email or a
 * phone push, at sixty, eighty and ninety percent of a window and when that
 * window resets. Those four thresholds are the product's, not a setting, so
 * nothing here writes one. What a person controls is which channel is on, when
 * it is quiet, whether a digest is wanted, and whether an email may carry
 * detail.
 *
 * THE HEADER THIS MODULE CANNOT INVENT
 * ------------------------------------
 * Every alert action on `pro-service` is authorised by a full scope device
 * token in `x-openlimiter-entitlement`, which is minted for a registered
 * device. A browser tab is not one, so a call made without a token is refused
 * before it reaches the database. Rather than sending a request that can only
 * fail, the functions below say `deviceRequired` and the surface renders the
 * honest state: alerts are arranged on the device that holds the grant.
 */

/** The two remote channels the server stores a preference row for. */
export type ProAlertChannel = "email" | "push";

/** The thresholds every alert fires at. Fixed by the product, never edited. */
export const PRO_ALERT_THRESHOLDS = [60, 80, 90] as const;

export interface ProAlertPreference {
  channel: ProAlertChannel;
  enabled: boolean;
  timeZone: string;
  quietStart: string;
  quietEnd: string;
  snoozedUntil: string | null;
  digestEnabled: boolean;
  detailConsentVersion: number | null;
  channelEpoch: number;
}

export interface ProAlertEvent {
  id: string;
  provider: string;
  meter: string;
  threshold: number | null;
  eventKind: string;
  observedAt: string | null;
  createdAt: string | null;
}

/** Every reason a call here can fail, including the one only a browser meets. */
export type ProAlertFailure = ProFailure | "deviceRequired" | "featureRequired";

export type ProAlertResult<T> = { ok: true; value: T } | { ok: false; reason: ProAlertFailure };

function statusOf(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const context = (error as Record<string, unknown>).context;
  if (context === null || typeof context !== "object") return null;
  const status = Number((context as Record<string, unknown>).status);
  return Number.isFinite(status) ? status : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function invoke<T>(
  client: SupabaseClient,
  body: Record<string, unknown>,
  deviceToken: string | null,
): Promise<ProAlertResult<T>> {
  if (deviceToken === null || deviceToken === "") return { ok: false, reason: "deviceRequired" };
  try {
    const response = await client.functions.invoke<T>("pro-service", {
      body,
      headers: { "x-openlimiter-entitlement": deviceToken },
    });
    if (response.error !== null || response.data === null || response.data === undefined) {
      const status = statusOf(response.error);
      if (status === 403) return { ok: false, reason: "featureRequired" };
      return { ok: false, reason: failureForStatus(status) };
    }
    return { ok: true, value: response.data };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export function preferenceOf(value: unknown): ProAlertPreference | null {
  const row = record(value);
  const channel = row?.channel;
  if (row === null || (channel !== "email" && channel !== "push")) return null;
  const consent = Number(row.detail_consent_version);
  const epoch = Number(row.channel_epoch);
  return {
    channel,
    enabled: row.enabled === true,
    timeZone: typeof row.time_zone === "string" ? row.time_zone : "UTC",
    quietStart: typeof row.quiet_start === "string" ? row.quiet_start.slice(0, 5) : "22:00",
    quietEnd: typeof row.quiet_end === "string" ? row.quiet_end.slice(0, 5) : "07:00",
    snoozedUntil: typeof row.snoozed_until === "string" ? row.snoozed_until : null,
    digestEnabled: row.digest_enabled === true,
    detailConsentVersion: Number.isFinite(consent) ? consent : null,
    channelEpoch: Number.isFinite(epoch) ? epoch : 0,
  };
}

/** Every stored channel preference, keyed by channel. */
export async function readProAlertPreferences(
  client: SupabaseClient,
  deviceToken: string | null,
): Promise<ProAlertResult<ProAlertPreference[]>> {
  const result = await invoke<Record<string, unknown>>(
    client,
    { action: "list_notification_preferences" },
    deviceToken,
  );
  if (!result.ok) return result;
  const rows = Array.isArray(result.value.preferences) ? result.value.preferences : [];
  const preferences: ProAlertPreference[] = [];
  for (const row of rows) {
    const parsed = preferenceOf(row);
    if (parsed !== null) preferences.push(parsed);
  }
  return { ok: true, value: preferences };
}

export interface ProAlertPreferenceInput {
  channel: ProAlertChannel;
  enabled: boolean;
  timeZone: string;
  quietStart: string;
  quietEnd: string;
  snoozedUntil: string | null;
  digestEnabled: boolean;
  detailConsent: boolean;
}

/** Write one channel's preference. The server writes exactly one channel. */
export async function saveProAlertPreference(
  client: SupabaseClient,
  input: ProAlertPreferenceInput,
  deviceToken: string | null,
): Promise<ProAlertResult<ProAlertPreference>> {
  const result = await invoke<Record<string, unknown>>(
    client,
    {
      action: "save_notification_preference",
      channel: input.channel,
      enabled: input.enabled,
      time_zone: input.timeZone,
      quiet_start: input.quietStart,
      quiet_end: input.quietEnd,
      snoozed_until: input.snoozedUntil,
      digest_enabled: input.digestEnabled,
      detail_consent: input.detailConsent,
    },
    deviceToken,
  );
  if (!result.ok) return result;
  const preference = preferenceOf(result.value.preference);
  return preference === null
    ? { ok: false, reason: "unavailable" }
    : { ok: true, value: preference };
}

export function alertEventOf(value: unknown): ProAlertEvent | null {
  const row = record(value);
  const id = row === null ? null : row.id;
  if (typeof id !== "string" || id === "") return null;
  const threshold = Number(row?.threshold);
  return {
    id,
    provider: typeof row?.provider === "string" ? row.provider : "",
    meter: typeof row?.meter === "string" ? row.meter : "",
    threshold: Number.isFinite(threshold) ? threshold : null,
    eventKind: typeof row?.event_kind === "string" ? row.event_kind : "",
    observedAt: typeof row?.observed_at === "string" ? row.observed_at : null,
    createdAt: typeof row?.created_at === "string" ? row.created_at : null,
  };
}

/** What has already been sent, newest first. Read only. */
export async function readProAlertHistory(
  client: SupabaseClient,
  deviceToken: string | null,
): Promise<ProAlertResult<ProAlertEvent[]>> {
  const result = await invoke<Record<string, unknown>>(
    client,
    { action: "alert_status" },
    deviceToken,
  );
  if (!result.ok) return result;
  const rows = Array.isArray(result.value.events) ? result.value.events : [];
  const events: ProAlertEvent[] = [];
  for (const row of rows) {
    const parsed = alertEventOf(row);
    if (parsed !== null) events.push(parsed);
  }
  return { ok: true, value: events };
}

/* ------------------------------------------------------------ browser push */

export function applicationServerKey(value: string): ArrayBuffer {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = window.atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function pushCapability(): "ready" | "permission_denied" | "unsupported" {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return Notification.permission === "denied" ? "permission_denied" : "ready";
}

/**
 * The key this deployment publishes to browsers.
 *
 * The private half never leaves the Pro server; this is the public half, so it
 * is inlined at build time like any other public value. A build that carries
 * no key is not broken, it simply cannot offer push, and every surface that
 * asks reads `unsupported` and says so instead of failing.
 */
export function pushPublicKey(): string {
  return process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
}

/** What a browser answered when it was asked for push. A refusal is a state. */
export type PushOutcome =
  | { state: "granted"; subscription: PushSubscriptionJSON }
  | { state: "denied" }
  | { state: "unsupported" };

/**
 * Ask this browser for push, and hand back the subscription without sending it.
 *
 * The wizard stages a subscription locally until the trial itself is started,
 * so somebody who grants the permission and then closes the card has given the
 * server nothing. That is why this is separate from `registerProPush`, which
 * files a subscription against a device grant a browser tab does not hold.
 *
 * Refusal is never an error here. A browser with no push, an insecure origin,
 * a permission already denied and a permission denied just now are all the same
 * answer to the reader: push is off, and the trial starts anyway.
 */
export async function subscribeBrowserPush(): Promise<PushOutcome> {
  const key = pushPublicKey();
  if (pushCapability() !== "ready" || key === "") return { state: "unsupported" };
  try {
    const permission =
      Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") return { state: "denied" };
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(key),
      }));
    return { state: "granted", subscription: subscription.toJSON() };
  } catch {
    return { state: "unsupported" };
  }
}

/**
 * Subscribe this browser to push and hand the subscription to the server.
 *
 * `deviceId` is the grant the subscription is filed under, so a revoked device
 * takes its push subscription with it.
 */
export async function registerProPush(
  client: SupabaseClient,
  input: { deviceId: string; vapidPublicKey: string },
  deviceToken: string | null,
): Promise<ProAlertResult<boolean>> {
  if (pushCapability() !== "ready" || input.vapidPublicKey === "") {
    return { ok: false, reason: "unavailable" };
  }
  const permission =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "unavailable" };
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(input.vapidPublicKey),
    }));
  const value = subscription.toJSON();
  const result = await invoke<Record<string, unknown>>(
    client,
    {
      action: "register_push",
      device_id: input.deviceId,
      endpoint: value.endpoint ?? "",
      p256dh: value.keys?.p256dh ?? "",
      auth: value.keys?.auth ?? "",
    },
    deviceToken,
  );
  if (!result.ok && existing === null) await subscription.unsubscribe();
  return result.ok ? { ok: true, value: result.value.registered === true } : result;
}
