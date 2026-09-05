"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { readDeviceToken } from "@/lib/device-session";
import {
  PRO_ALERT_THRESHOLDS,
  readProAlertPreferences,
  saveProAlertPreference,
  type ProAlertChannel,
  type ProAlertFailure,
  type ProAlertPreference,
} from "@/lib/pro-notifications";

export interface AlertScope {
  provider: string;
  meter: string;
  label: string;
}

type LoadState = "idle" | "loading" | "ready" | ProAlertFailure;

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

const CHANNEL_LABEL: Record<ProAlertChannel, string> = {
  email: "Email alerts",
  push: "Phone push",
};

function emptyPreference(channel: ProAlertChannel): ProAlertPreference {
  return {
    channel,
    enabled: false,
    timeZone: "UTC",
    quietStart: "22:00",
    quietEnd: "07:00",
    snoozedUntil: null,
    digestEnabled: false,
    detailConsentVersion: null,
    channelEpoch: 0,
  };
}

/**
 * The alert control.
 *
 * Every alert is a Pro alert and every one of them fires at the same four
 * moments: sixty, eighty and ninety percent of a window, and the reset. That is
 * the product rather than a setting, so this panel states the thresholds and
 * offers only the choices that exist: which channel is on, when it is quiet,
 * and whether email may carry detail.
 *
 * A browser tab holds no device grant of its own, so the hosted alert actions
 * refuse it. That is not an error to apologise for: it is where the feature
 * lives, and the panel says so and points at the download.
 */
export function NotificationBell({
  client,
  scopes,
}: {
  client: SupabaseClient;
  scopes: readonly AlertScope[];
}) {
  const [open, setOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [preferences, setPreferences] = useState<ProAlertPreference[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  const watched = useMemo(() => {
    const unique = new Set<string>();
    for (const scope of scopes) unique.add(`${scope.provider}${scope.meter}`);
    return unique.size;
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
    void readProAlertPreferences(client, readDeviceToken()).then((result) => {
      if (!result.ok) {
        setLoadState(result.reason);
        return;
      }
      const byChannel = new Map(result.value.map((row) => [row.channel, row]));
      setPreferences([
        byChannel.get("email") ?? emptyPreference("email"),
        byChannel.get("push") ?? emptyPreference("push"),
      ]);
      setLoadState("ready");
    });
  }, [client, loadState, open]);

  async function save(next: ProAlertPreference) {
    setBusy(true);
    setMessage("");
    const result = await saveProAlertPreference(
      client,
      {
        channel: next.channel,
        enabled: next.enabled,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        quietStart: next.quietStart,
        quietEnd: next.quietEnd,
        snoozedUntil: next.snoozedUntil,
        digestEnabled: next.channel === "email" && next.digestEnabled,
        detailConsent: next.channel === "email" && next.detailConsentVersion !== null,
      },
      readDeviceToken(),
    );
    if (result.ok) {
      setPreferences((current) =>
        current.map((row) => (row.channel === result.value.channel ? result.value : row)),
      );
      setMessage("Alert preferences saved.");
    } else {
      setMessage("Alert preferences could not be saved.");
    }
    setBusy(false);
  }

  function update(channel: ProAlertChannel, patch: Partial<ProAlertPreference>) {
    setPreferences((current) =>
      current.map((row) => (row.channel === channel ? { ...row, ...patch } : row)),
    );
  }

  return (
    <div ref={wrap} className="ol-notification-wrap">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Open alerts"
        title="Open alerts"
        onClick={() => setOpen((current) => !current)}
        className="ol-icon-control ol-tap focus-ring"
      >
        <BellGlyph />
      </button>

      {open && (
        <section className="ol-menu ol-notification-popover" role="dialog" aria-label="Alerts">
          <div className="ol-notification-heading">
            <strong>Alerts</strong>
            <span>Pro</span>
          </div>
          <p>
            Every alert fires at {PRO_ALERT_THRESHOLDS.join(", ")} percent of a window, and again
            when that window resets. Alerts are part of Pro.
          </p>
          {watched > 0 && <p>{watched} windows are on this screen right now.</p>}

          {loadState === "loading" && <p>Reading your alert preferences.</p>}
          {loadState === "deviceRequired" && (
            <p>
              Alerts are arranged on a device that holds a grant. Open the desktop application and
              turn them on there, then this account alerts every device.{" "}
              <Link href="/en/download">Get the desktop application</Link>.
            </p>
          )}
          {(loadState === "featureRequired" || loadState === "alreadySubscribed") && (
            <p>
              Alerts need Pro. <Link href="/en/pro">See what Pro adds</Link>.
            </p>
          )}
          {loadState === "unauthenticated" && <p>Sign in again to read your alert preferences.</p>}
          {(loadState === "unavailable" || loadState === "rateLimited") && (
            <p>Alert preferences are unavailable right now.</p>
          )}

          {loadState === "ready" && (
            <div className="ol-notification-settings">
              {preferences.map((preference) => (
                <div key={preference.channel}>
                  <label className="ol-notification-toggle">
                    <span>{CHANNEL_LABEL[preference.channel]}</span>
                    <input
                      type="checkbox"
                      checked={preference.enabled}
                      disabled={busy}
                      onChange={(event) => {
                        const next = { ...preference, enabled: event.target.checked };
                        update(preference.channel, { enabled: event.target.checked });
                        void save(next);
                      }}
                    />
                  </label>
                  {preference.enabled && (
                    <div className="ol-notification-times">
                      <label>
                        Quiet from
                        <input
                          type="time"
                          value={preference.quietStart}
                          onChange={(event) =>
                            update(preference.channel, { quietStart: event.target.value })
                          }
                          onBlur={() => void save(preference)}
                        />
                      </label>
                      <label>
                        Until
                        <input
                          type="time"
                          value={preference.quietEnd}
                          onChange={(event) =>
                            update(preference.channel, { quietEnd: event.target.value })
                          }
                          onBlur={() => void save(preference)}
                        />
                      </label>
                    </div>
                  )}
                  {preference.channel === "email" && preference.enabled && (
                    <label className="ol-notification-toggle">
                      <span>Daily digest</span>
                      <input
                        type="checkbox"
                        checked={preference.digestEnabled}
                        disabled={busy}
                        onChange={(event) => {
                          const next = { ...preference, digestEnabled: event.target.checked };
                          update(preference.channel, { digestEnabled: event.target.checked });
                          void save(next);
                        }}
                      />
                    </label>
                  )}
                </div>
              ))}
              <p>
                A push payload never carries usage detail, whatever the email setting says, so a
                locked screen never shows one.
              </p>
              <p role="status">{message}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
