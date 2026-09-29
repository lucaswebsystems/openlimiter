import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_KINDS, activityDedupeKey, isNotificationPreferences, isNotificationSubmission, shouldNotifyLocally,
  shouldSendRemote, thresholdDedupeKey, type NotificationPreferences, type NotificationSubmission
} from "../src/contracts/notify.js";

const now = Date.parse("2026-09-28T12:00:00.000Z");
const preferences = (): NotificationPreferences => ({
  local: { enabled: true, quietHours: null, snoozedUntil: null, mutedProviders: [] },
  remote: { enabled: true, quietHours: null, snoozedUntil: null, mutedProviders: [] }
});
const submission = (changes: Partial<NotificationSubmission> = {}): NotificationSubmission => ({
  kind: "threshold", dedupeKey: thresholdDedupeKey("CLAUDE", null, "five-hour", "cycle-1", "threshold", 80),
  provider: "CLAUDE", account: null, localChannel: "popup", remoteChannel: true, ...changes
});

describe("notification contract", () => {
  it.each(["CLAUDE", "CODEX", "MUSE", "GEMINI_CLI", "CURSOR", "KIMI", "GROK", "ANTIGRAVITY"] as const)
  ("accepts and independently mutes activity notifications for %s", (provider) => {
    const item = submission({ provider, kind: "agent_waiting", dedupeKey: activityDedupeKey(provider, null, "session", 1, "agent_waiting") });
    const prefs = preferences();
    expect(isNotificationSubmission(item)).toBe(true);
    expect(shouldNotifyLocally(item, prefs, now)).toBe(true);
    prefs.local.mutedProviders = [provider];
    expect(shouldNotifyLocally(item, prefs, now)).toBe(false);
    expect(shouldSendRemote(item, prefs, now, { remoteNotifications: true })).toBe(true);
  });
  it.each(NOTIFICATION_KINDS)("local %s is free, remote %s requires entitlement", (kind) => {
    const dedupeKey = kind === "agent_waiting" || kind === "agent_done" ? activityDedupeKey("CLAUDE", null, "session", 1, kind) :
      thresholdDedupeKey("CLAUDE", null, "meter", "cycle", kind, kind === "threshold" ? 60 : null);
    const item = submission({ kind, dedupeKey });
    expect(isNotificationSubmission(item)).toBe(true);
    const prefs = preferences();
    for (const remoteNotifications of [false, true]) {
      expect(shouldNotifyLocally(item, prefs, now)).toBe(true);
      expect(shouldSendRemote(item, prefs, now, { remoteNotifications })).toBe(remoteNotifications);
    }
  });
  it("never reads an entitlement from local preferences", () => {
    const prefs = preferences();
    Object.defineProperty(prefs, "entitlement", { get() { throw new Error("Local must not read entitlement"); } });
    expect(shouldNotifyLocally(submission(), prefs, now)).toBe(true);
  });
  it("keeps channel flags and channel preferences independent", () => {
    expect(shouldNotifyLocally(submission({ localChannel: "none" }), preferences(), now)).toBe(false);
    expect(shouldSendRemote(submission({ remoteChannel: false }), preferences(), now, { remoteNotifications: true })).toBe(false);
    const prefs = preferences();
    prefs.local.enabled = false;
    expect(shouldNotifyLocally(submission(), prefs, now)).toBe(false);
    expect(shouldSendRemote(submission(), prefs, now, { remoteNotifications: true })).toBe(true);
    prefs.local.enabled = true;
    prefs.remote.enabled = false;
    expect(shouldNotifyLocally(submission(), prefs, now)).toBe(true);
    expect(shouldSendRemote(submission(), prefs, now, { remoteNotifications: true })).toBe(false);
  });
  it.each(["local", "remote"] as const)("honors %s snooze and provider mute only on that channel", (channel) => {
    const prefs = preferences();
    const test = (): boolean => channel === "local" ? shouldNotifyLocally(submission(), prefs, now) :
      shouldSendRemote(submission(), prefs, now, { remoteNotifications: true });
    prefs[channel].snoozedUntil = new Date(now + 1).toISOString();
    expect(test()).toBe(false);
    prefs[channel].snoozedUntil = new Date(now).toISOString();
    expect(test()).toBe(true);
    prefs[channel].mutedProviders = ["CODEX"];
    expect(test()).toBe(true);
    prefs[channel].mutedProviders = ["CLAUDE"];
    expect(test()).toBe(false);
    expect(channel === "local" ? shouldSendRemote(submission(), prefs, now, { remoteNotifications: true }) :
      shouldNotifyLocally(submission(), prefs, now)).toBe(true);
  });
  it.each([
    ["2026-09-28T21:59:59.999Z", 1320, 420, 0, true],
    ["2026-09-28T22:00:00.000Z", 1320, 420, 0, false],
    ["2026-09-29T06:59:59.999Z", 1320, 420, 0, false],
    ["2026-09-29T07:00:00.000Z", 1320, 420, 0, true],
    ["2026-09-28T12:00:00.000Z", 540, 600, -180, false],
    ["2026-09-28T12:00:00.000Z", 540, 600, -120, true],
    ["2026-09-28T12:00:00.000Z", 0, 0, 0, true]
  ] as const)("quiet hours at %s, %d to %d, offset %d", (time, startMinute, endMinute, utcOffsetMinutes, allowed) => {
    const prefs = preferences();
    prefs.local.quietHours = { startMinute, endMinute, utcOffsetMinutes };
    prefs.remote.quietHours = { startMinute, endMinute, utcOffsetMinutes };
    expect(shouldNotifyLocally(submission(), prefs, Date.parse(time))).toBe(allowed);
    expect(shouldSendRemote(submission(), prefs, Date.parse(time), { remoteNotifications: true })).toBe(allowed);
  });
  it("separates namespaces and unambiguously scopes dedupe identity", () => {
    const threshold = thresholdDedupeKey("CLAUDE", null, "meter", "cycle", "threshold", 60);
    const activity = activityDedupeKey("CLAUDE", null, "meter", 0, "agent_done");
    expect(threshold).toMatch(/^threshold:/u);
    expect(activity).toMatch(/^activity:/u);
    expect(new Set([
      threshold, activity, thresholdDedupeKey("CLAUDE", "default", "meter", "cycle", "threshold", 60),
      thresholdDedupeKey("CODEX", null, "meter", "cycle", "threshold", 60),
      thresholdDedupeKey("CLAUDE", null, "meter", "cycle2", "threshold", 60),
      thresholdDedupeKey("CLAUDE", null, "meter2", "cycle", "threshold", 60),
      thresholdDedupeKey("CLAUDE", null, "meter", "cycle", "threshold", 80),
      activityDedupeKey("CLAUDE", null, "meter", 1, "agent_done"),
      activityDedupeKey("CLAUDE", null, "meter", 0, "agent_waiting")
    ]).size).toBe(9);
    expect(thresholdDedupeKey("CLAUDE", "a:b", "c", "d", "reset"))
      .not.toBe(thresholdDedupeKey("CLAUDE", "a", "b:c", "d", "reset"));
    expect(() => thresholdDedupeKey("CLAUDE", null, "meter", "cycle", "threshold")).toThrow();
  });
  it.each([
    { kind: "other" }, { account: "" }, { provider: "OTHER" }, { localChannel: true }, { remoteChannel: "true" },
    { prompt: "secret" }, { dedupeKey: "threshold:random" }, { dedupeKey: "activity:[]" },
    { dedupeKey: thresholdDedupeKey("CODEX", null, "m", "w", "threshold", 80) },
    { dedupeKey: thresholdDedupeKey("CLAUDE", "other", "m", "w", "threshold", 80) },
    { dedupeKey: 'threshold:["CLAUDE",null,"m","w","threshold",99]' }
  ])("rejects malformed submission %j", (changes) => {
    const bad = { ...submission(), ...changes };
    expect(isNotificationSubmission(bad)).toBe(false);
    expect(shouldNotifyLocally(bad as NotificationSubmission, preferences(), now)).toBe(false);
  });
  it("validates preferences and fails closed on bad clocks or intervals", () => {
    expect(isNotificationPreferences(preferences())).toBe(true);
    expect(isNotificationPreferences({ ...preferences(), entitlement: false })).toBe(false);
    expect(shouldNotifyLocally(submission(), preferences(), NaN)).toBe(false);
    const prefs = preferences();
    prefs.local.quietHours = { startMinute: -1, endMinute: 1440, utcOffsetMinutes: 900 };
    expect(isNotificationPreferences(prefs)).toBe(false);
    expect(shouldNotifyLocally(submission(), prefs, now)).toBe(false);
    prefs.local.quietHours = null;
    prefs.local.snoozedUntil = "tomorrow";
    expect(isNotificationPreferences(prefs)).toBe(false);
  });
});
