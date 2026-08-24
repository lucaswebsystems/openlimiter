import type { SupabaseClient } from "@supabase/supabase-js";

export interface ProNotificationPreferences {
  email_enabled: boolean;
  push_enabled: boolean;
  quiet_hours_enabled: boolean;
  quiet_start: string;
  quiet_end: string;
  time_zone: string;
  daily_digest_enabled: boolean;
  daily_digest_time: string;
  last_digest_local_date: string | null;
}

export interface ProAlertRule {
  id: string;
  provider: string;
  meter: string;
  threshold_percent: number;
  notify_reset: boolean;
  enabled: boolean;
}

export interface ProNotificationState {
  preferences: ProNotificationPreferences;
  rules: ProAlertRule[];
  pushSubscribed: boolean;
  emailReady: boolean;
  pushReady: boolean;
  vapidPublicKey: string;
}

export type ProNotificationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "entitlement" | "unavailable" };

function errorStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const context = (error as Record<string, unknown>).context;
  if (context === null || typeof context !== "object") return null;
  const status = Number((context as Record<string, unknown>).status);
  return Number.isFinite(status) ? status : null;
}

async function invoke<T>(
  client: SupabaseClient,
  body: Record<string, unknown>,
): Promise<ProNotificationResult<T>> {
  const response = await client.functions.invoke<T>("pro-service", { body });
  if (response.error !== null || response.data === null) {
    return { ok: false, reason: errorStatus(response.error) === 403 ? "entitlement" : "unavailable" };
  }
  return { ok: true, value: response.data };
}

interface SettingsResponse {
  preferences: ProNotificationPreferences;
  push_subscribed: boolean;
  email_ready: boolean;
  push_ready: boolean;
  vapid_public_key: string;
}

interface RulesResponse {
  rules: ProAlertRule[];
}

export async function readProNotificationState(
  client: SupabaseClient,
): Promise<ProNotificationResult<ProNotificationState>> {
  const [settings, rules] = await Promise.all([
    invoke<SettingsResponse>(client, { action: "notification_settings" }),
    invoke<RulesResponse>(client, { action: "list_alert_rules" }),
  ]);
  if (!settings.ok) return settings;
  if (!rules.ok) return rules;
  return {
    ok: true,
    value: {
      preferences: settings.value.preferences,
      rules: rules.value.rules,
      pushSubscribed: settings.value.push_subscribed,
      emailReady: settings.value.email_ready,
      pushReady: settings.value.push_ready,
      vapidPublicKey: settings.value.vapid_public_key,
    },
  };
}

export async function saveProNotificationPreferences(
  client: SupabaseClient,
  preferences: ProNotificationPreferences,
): Promise<ProNotificationResult<ProNotificationPreferences>> {
  const result = await invoke<{ preferences: ProNotificationPreferences }>(client, {
    action: "save_notification_preferences",
    ...preferences,
  });
  return result.ok ? { ok: true, value: result.value.preferences } : result;
}

export async function saveProAlertRule(
  client: SupabaseClient,
  input: {
    provider: string;
    meter: string;
    thresholdPercent: number;
    notifyReset: boolean;
  },
): Promise<ProNotificationResult<ProAlertRule>> {
  const result = await invoke<{ rule: ProAlertRule }>(client, {
    action: "save_alert_rule",
    provider: input.provider,
    meter: input.meter,
    threshold_percent: input.thresholdPercent,
    notify_reset: input.notifyReset,
    enabled: true,
  });
  return result.ok ? { ok: true, value: result.value.rule } : result;
}

export async function deleteProAlertRule(
  client: SupabaseClient,
  ruleId: string,
): Promise<ProNotificationResult<boolean>> {
  const result = await invoke<{ deleted: boolean }>(client, {
    action: "delete_alert_rule",
    rule_id: ruleId,
  });
  return result.ok ? { ok: true, value: result.value.deleted } : result;
}

function applicationServerKey(value: string): ArrayBuffer {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  const binary = window.atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function pushCapability(): "ready" | "permission_denied" | "unsupported" {
  if (
    typeof window === "undefined" || !window.isSecureContext ||
    !("serviceWorker" in navigator) || !("PushManager" in window) ||
    !("Notification" in window)
  ) {
    return "unsupported";
  }
  return Notification.permission === "denied" ? "permission_denied" : "ready";
}

export async function enableProPush(
  client: SupabaseClient,
  vapidPublicKey: string,
): Promise<ProNotificationResult<boolean>> {
  if (pushCapability() !== "ready" || vapidPublicKey === "") {
    return { ok: false, reason: "unavailable" };
  }
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "unavailable" };
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(vapidPublicKey),
  });
  const value = subscription.toJSON();
  const endpoint = value.endpoint ?? "";
  const p256dh = value.keys?.p256dh ?? "";
  const auth = value.keys?.auth ?? "";
  const result = await invoke<{ subscribed: boolean }>(client, {
    action: "save_push_subscription",
    endpoint,
    p256dh,
    auth,
    expires_at: value.expirationTime === null || value.expirationTime === undefined
      ? null
      : new Date(value.expirationTime).toISOString(),
  });
  if (!result.ok && existing === null) await subscription.unsubscribe();
  return result.ok ? { ok: true, value: result.value.subscribed } : result;
}

export async function disableProPush(
  client: SupabaseClient,
): Promise<ProNotificationResult<boolean>> {
  if (!("serviceWorker" in navigator)) return { ok: false, reason: "unavailable" };
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return { ok: true, value: false };
  const result = await invoke<{ subscribed: boolean }>(client, {
    action: "delete_push_subscription",
    endpoint: subscription.endpoint,
  });
  if (!result.ok) return result;
  await subscription.unsubscribe();
  return { ok: true, value: false };
}
