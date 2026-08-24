"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteProAlertRule,
  disableProPush,
  enableProPush,
  pushCapability,
  readProNotificationState,
  saveProAlertRule,
  saveProNotificationPreferences,
  type ProNotificationPreferences,
  type ProNotificationState,
} from "@/lib/pro-notifications";

export interface AlertScope {
  provider: string;
  meter: string;
  label: string;
}

type LoadState = "idle" | "loading" | "ready" | "entitlement" | "unavailable";

function BellGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />
    </svg>
  );
}

function normalizedPreferences(value: ProNotificationPreferences): ProNotificationPreferences {
  return {
    ...value,
    quiet_start: value.quiet_start.slice(0, 5),
    quiet_end: value.quiet_end.slice(0, 5),
    daily_digest_time: value.daily_digest_time.slice(0, 5),
  };
}

export function NotificationBell({
  client,
  scopes,
}: {
  client: SupabaseClient;
  scopes: readonly AlertScope[];
}) {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [state, setState] = useState<ProNotificationState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [scopeKey, setScopeKey] = useState("");
  const [threshold, setThreshold] = useState(90);
  const [notifyReset, setNotifyReset] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  const availableScopes = useMemo(() => {
    const unique = new Map<string, AlertScope>();
    for (const scope of scopes) unique.set(`${scope.provider}\u001f${scope.meter}`, scope);
    return [...unique.values()];
  }, [scopes]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const closeOnPointer = (event: MouseEvent) => {
      if (wrap.current !== null && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", closeOnKey);
    document.addEventListener("mousedown", closeOnPointer);
    return () => {
      document.removeEventListener("keydown", closeOnKey);
      document.removeEventListener("mousedown", closeOnPointer);
    };
  }, [open]);

  useEffect(() => {
    if (!open || loadState !== "idle") return;
    setLoadState("loading");
    void readProNotificationState(client).then((result) => {
      if (!result.ok) {
        setLoadState(result.reason);
        return;
      }
      setState({
        ...result.value,
        preferences: normalizedPreferences(result.value.preferences),
      });
      setScopeKey((current) => current || (
        availableScopes[0] === undefined
          ? ""
          : `${availableScopes[0].provider}\u001f${availableScopes[0].meter}`
      ));
      setLoadState("ready");
    });
  }, [availableScopes, client, loadState, open]);

  function updatePreferences(update: Partial<ProNotificationPreferences>) {
    setState((current) => current === null
      ? current
      : { ...current, preferences: { ...current.preferences, ...update } });
  }

  async function savePreferences(preferences: ProNotificationPreferences) {
    setBusy(true);
    setMessage("");
    const result = await saveProNotificationPreferences(client, {
      ...preferences,
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    if (result.ok) {
      updatePreferences(normalizedPreferences(result.value));
      setMessage("Notification preferences saved.");
    } else {
      setMessage("Notification preferences could not be saved.");
    }
    setBusy(false);
  }

  async function togglePush(enable: boolean) {
    if (state === null) return;
    setBusy(true);
    setMessage("");
    const subscription = enable
      ? await enableProPush(client, state.vapidPublicKey)
      : await disableProPush(client);
    if (!subscription.ok) {
      setMessage(pushCapability() === "permission_denied"
        ? "Browser notification permission is blocked."
        : "Push notifications are unavailable on this device.");
      setBusy(false);
      return;
    }
    const preferences = { ...state.preferences, push_enabled: enable };
    const saved = await saveProNotificationPreferences(client, preferences);
    if (saved.ok) {
      setState({
        ...state,
        pushSubscribed: enable,
        preferences: normalizedPreferences(saved.value),
      });
      setMessage(enable ? "Push notifications enabled." : "Push notifications disabled.");
    } else {
      setMessage("Push preferences could not be saved.");
    }
    setBusy(false);
  }

  async function addRule() {
    if (state === null) return;
    const [provider, meter] = scopeKey.split("\u001f");
    if (provider === undefined || meter === undefined) return;
    setBusy(true);
    setMessage("");
    const result = await saveProAlertRule(client, {
      provider,
      meter,
      thresholdPercent: threshold,
      notifyReset,
    });
    if (result.ok) {
      setState({ ...state, rules: [...state.rules, result.value] });
      setMessage("Alert rule added.");
    } else {
      setMessage("Alert rule could not be added.");
    }
    setBusy(false);
  }

  async function removeRule(ruleId: string) {
    if (state === null) return;
    setBusy(true);
    setMessage("");
    const result = await deleteProAlertRule(client, ruleId);
    if (result.ok) {
      setState({ ...state, rules: state.rules.filter((rule) => rule.id !== ruleId) });
      setMessage("Alert rule removed.");
    } else {
      setMessage("Alert rule could not be removed.");
    }
    setBusy(false);
  }

  return (
    <div ref={wrap} className="ol-notification-wrap">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open notifications"
        title="Open notifications"
        onClick={() => setOpen((current) => !current)}
        className="ol-icon-control ol-tap focus-ring"
      >
        <BellGlyph />
      </button>

      {open && (
        <section className="ol-menu ol-notification-popover" role="dialog" aria-label="Notifications">
          <div className="ol-notification-heading">
            <strong>Notifications</strong>
            <span>Pro controls</span>
          </div>
          {loadState === "loading" && <p>Loading notification settings.</p>}
          {loadState === "entitlement" && (
            <p>Pro adds email, phone push, custom limits, quiet hours, and a daily digest. <Link href="/en/pricing">View pricing</Link>.</p>
          )}
          {loadState === "unavailable" && <p>Notification settings are unavailable right now.</p>}
          {loadState === "ready" && state !== null && (
            <div className="ol-notification-settings">
              <label className="ol-notification-toggle">
                <span>Email alerts</span>
                <input
                  type="checkbox"
                  checked={state.preferences.email_enabled}
                  onChange={(event) => updatePreferences({ email_enabled: event.target.checked })}
                />
              </label>
              {!state.emailReady && <p>Email delivery will start when Resend is configured.</p>}
              <div className="ol-notification-toggle">
                <span>Phone push</span>
                <button
                  type="button"
                  className="ol-inline-action focus-ring"
                  disabled={busy || !state.pushReady}
                  onClick={() => void togglePush(!state.pushSubscribed)}
                >
                  {state.pushSubscribed ? "Disable" : "Enable"}
                </button>
              </div>
              {!state.pushReady && <p>Push delivery is not configured yet.</p>}
              <label className="ol-notification-toggle">
                <span>Quiet hours</span>
                <input
                  type="checkbox"
                  checked={state.preferences.quiet_hours_enabled}
                  onChange={(event) => updatePreferences({ quiet_hours_enabled: event.target.checked })}
                />
              </label>
              {state.preferences.quiet_hours_enabled && (
                <div className="ol-notification-times">
                  <label>From<input type="time" value={state.preferences.quiet_start} onChange={(event) => updatePreferences({ quiet_start: event.target.value })} /></label>
                  <label>Until<input type="time" value={state.preferences.quiet_end} onChange={(event) => updatePreferences({ quiet_end: event.target.value })} /></label>
                </div>
              )}
              <label className="ol-notification-toggle">
                <span>Daily digest</span>
                <input
                  type="checkbox"
                  checked={state.preferences.daily_digest_enabled}
                  onChange={(event) => updatePreferences({ daily_digest_enabled: event.target.checked })}
                />
              </label>
              {state.preferences.daily_digest_enabled && (
                <label className="ol-notification-time">Digest time<input type="time" value={state.preferences.daily_digest_time} onChange={(event) => updatePreferences({ daily_digest_time: event.target.value })} /></label>
              )}
              <button
                type="button"
                className="ol-control ol-control-ghost ol-tap focus-ring border text-sm font-medium"
                disabled={busy}
                onClick={() => void savePreferences(state.preferences)}
              >
                Save preferences
              </button>

              <div className="ol-notification-rules">
                <strong>Custom limits</strong>
                {state.rules.map((rule) => (
                  <div key={rule.id} className="ol-notification-rule">
                    <span>{rule.provider} {rule.meter} at {rule.threshold_percent} percent</span>
                    <button type="button" className="ol-inline-action focus-ring" disabled={busy} onClick={() => void removeRule(rule.id)}>Remove</button>
                  </div>
                ))}
                {availableScopes.length === 0 ? (
                  <p>Sync a provider before adding a custom limit.</p>
                ) : (
                  <div className="ol-notification-rule-form">
                    <select aria-label="Provider window" value={scopeKey} onChange={(event) => setScopeKey(event.target.value)}>
                      {availableScopes.map((scope) => (
                        <option key={`${scope.provider}:${scope.meter}`} value={`${scope.provider}\u001f${scope.meter}`}>{scope.label}</option>
                      ))}
                    </select>
                    <label>Percent<input type="number" min="1" max="100" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></label>
                    <label className="ol-notification-toggle"><span>Notify on reset</span><input type="checkbox" checked={notifyReset} onChange={(event) => setNotifyReset(event.target.checked)} /></label>
                    <button type="button" className="ol-control ol-control-ghost ol-tap focus-ring border text-sm font-medium" disabled={busy} onClick={() => void addRule()}>Add limit</button>
                  </div>
                )}
              </div>
              <p role="status">{message}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
