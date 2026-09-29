import { PROVIDER_CODES, type ProviderCode } from "../types.js";
import { hasOnlyContractKeys, isContractInstant, isContractObject } from "../activity/contract.js";

/** Activity support includes agents with no quota connector yet. */
export const NOTIFICATION_PROVIDERS = [...PROVIDER_CODES, "MUSE", "CURSOR"] as const;
export type NotificationProvider = ProviderCode | "MUSE" | "CURSOR";
export const NOTIFICATION_KINDS = ["threshold", "limit_reached", "reset", "agent_waiting", "agent_done"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export type ThresholdNotificationKind = Exclude<NotificationKind, "agent_waiting" | "agent_done">;
export type ActivityNotificationKind = Extract<NotificationKind, "agent_waiting" | "agent_done">;

export interface NotificationSubmission {
  kind: NotificationKind;
  dedupeKey: string;
  provider: NotificationProvider;
  /** null means the unnamed account; it is distinct from an account called default. */
  account: string | null;
  localChannel: "popup" | "none";
  remoteChannel: boolean;
}
export interface QuietHours {
  /** Minutes from midnight, [0, 1440). Equal endpoints disable the interval. */
  startMinute: number;
  endMinute: number;
  /** The caller supplies the offset at now, including any DST change. */
  utcOffsetMinutes: number;
}
export interface NotificationChannelPreferences {
  enabled: boolean;
  quietHours: QuietHours | null;
  snoozedUntil: string | null;
  mutedProviders: readonly NotificationProvider[];
}
export interface NotificationPreferences {
  local: NotificationChannelPreferences;
  remote: NotificationChannelPreferences;
}
export interface RemoteNotificationEntitlement { remoteNotifications: boolean }

const textId = (value: unknown): value is string => typeof value === "string" && value["length"] > 0 &&
  value["length"] <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
const provider = (value: unknown): value is NotificationProvider =>
  typeof value === "string" && (NOTIFICATION_PROVIDERS as readonly string[]).includes(value);
const account = (value: unknown): value is string | null => value === null || textId(value);

/** cycleId identifies a persisted meter window, not the time a popup was delivered. */
export function thresholdDedupeKey(provider: NotificationProvider, account: string | null, meterId: string,
  cycleId: string, kind: ThresholdNotificationKind, threshold: 60 | 80 | 90 | null = null): string {
  if ((kind === "threshold") !== (threshold !== null)) throw new TypeError("notify: threshold required only for threshold kind");
  return "threshold:" + JSON.stringify([provider, account, meterId, cycleId, kind, threshold]);
}
/** Use the sanitized session id. Sequence identifies the transition, not a delivery attempt. */
export function activityDedupeKey(provider: NotificationProvider, account: string | null, sessionId: string,
  sequence: number, kind: ActivityNotificationKind): string {
  return "activity:" + JSON.stringify([provider, account, sessionId, sequence, kind]);
}
function validDedupeKey(value: Record<string, unknown>): boolean {
  if (typeof value["dedupeKey"] !== "string" || value["dedupeKey"].length > 2048) return false;
  const activity = value["kind"] === "agent_waiting" || value["kind"] === "agent_done";
  const prefix = activity ? "activity:" : "threshold:";
  if (!value["dedupeKey"].startsWith(prefix)) return false;
  let parts: unknown;
  try { parts = JSON.parse(value["dedupeKey"].slice(prefix.length)); } catch { return false; }
  if (!Array.isArray(parts) || parts.length !== (activity ? 5 : 6) ||
    parts[0] !== value["provider"] || parts[1] !== value["account"] || parts[4] !== value["kind"] || !textId(parts[2])) return false;
  if (value["dedupeKey"] !== prefix + JSON.stringify(parts)) return false;
  return activity ? Number.isSafeInteger(parts[3]) && (parts[3] as number) >= 0 :
    textId(parts[3]) && (value["kind"] === "threshold" ? [60,80,90].includes(parts[5] as number) : parts[5] === null);
}
export function isNotificationSubmission(value: unknown): value is NotificationSubmission {
  return isContractObject(value) && hasOnlyContractKeys(value, ["kind", "dedupeKey", "provider", "account", "localChannel", "remoteChannel"]) &&
    (NOTIFICATION_KINDS as readonly unknown[]).includes(value["kind"]) && provider(value["provider"]) && account(value["account"]) &&
    (value["localChannel"] === "popup" || value["localChannel"] === "none") && typeof value["remoteChannel"] === "boolean" && validDedupeKey(value);
}
function isChannelPreferences(value: unknown): value is NotificationChannelPreferences {
  if (!isContractObject(value) || !hasOnlyContractKeys(value, ["enabled", "quietHours", "snoozedUntil", "mutedProviders"]) ||
    typeof value["enabled"] !== "boolean" || !(value["snoozedUntil"] === null || isContractInstant(value["snoozedUntil"])) ||
    !Array.isArray(value["mutedProviders"]) || !value["mutedProviders"].every(provider)) return false;
  if (value["quietHours"] === null) return true;
  const q = value["quietHours"];
  return isContractObject(q) && hasOnlyContractKeys(q, ["startMinute", "endMinute", "utcOffsetMinutes"]) &&
    [q["startMinute"], q["endMinute"]].every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 1440) &&
    Number.isInteger(q["utcOffsetMinutes"]) && Math.abs(q["utcOffsetMinutes"] as number) <= 840;
}
export function isNotificationPreferences(value: unknown): value is NotificationPreferences {
  return isContractObject(value) && hasOnlyContractKeys(value, ["local", "remote"]) &&
    isChannelPreferences(value["local"]) && isChannelPreferences(value["remote"]);
}
function permits(submission: NotificationSubmission, preferences: NotificationChannelPreferences, now: number): boolean {
  if (!isNotificationSubmission(submission) || !isChannelPreferences(preferences) || !Number.isFinite(now) ||
    !preferences.enabled || preferences.mutedProviders.includes(submission.provider) ||
    (preferences.snoozedUntil !== null && now < Date.parse(preferences.snoozedUntil))) return false;
  const quiet = preferences.quietHours;
  if (quiet === null || quiet.startMinute === quiet.endMinute) return true;
  const minute = ((Math.floor(now / 60_000) + quiet.utcOffsetMinutes) % 1440 + 1440) % 1440;
  const inQuiet = quiet.startMinute < quiet.endMinute ?
    minute >= quiet.startMinute && minute < quiet.endMinute : minute >= quiet.startMinute || minute < quiet.endMinute;
  return !inQuiet;
}
/** R2: this API has no entitlement input. Local notifications are free. */
export function shouldNotifyLocally(submission: NotificationSubmission, preferences: NotificationPreferences, now: number): boolean {
  return submission.localChannel === "popup" && permits(submission, preferences.local, now);
}
export function shouldSendRemote(submission: NotificationSubmission, preferences: NotificationPreferences, now: number,
  entitlement: RemoteNotificationEntitlement): boolean {
  return entitlement.remoteNotifications === true && submission.remoteChannel && permits(submission, preferences.remote, now);
}
