"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { BandHorizon } from "./horizon";
import { Button } from "./pieces";
import { subscribeBrowserPush, type PushOutcome } from "@/lib/pro-notifications";
import { proAccessState, startProCheckout, type ProAccessState, type ProEntitlement } from "@/lib/pro";
import {
  isAllowedCheckoutUrl,
  locksPro,
  offersTrial,
  startOfferCheckout,
  startProTrial,
  type TrialFailure,
} from "@/lib/pro-trial";
import { useOfferCountdown } from "@/lib/use-offer-countdown";
import { PRO_YEARLY_PRICE } from "@/lib/site";
import { ExpiredProSummary } from "@/components/pro-expired-summary";

/**
 * The trial, the wizard that starts it, and the lock that follows it.
 *
 * The trial starts with the server's recommended profile. The only question a
 * browser can answer is whether this browser may receive push notifications.
 * That permission is asked from the one start button, and a refusal still
 * starts the trial.
 */

/* --------------------------------------------------------------- the button */

function SparkGlyph() {
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
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="10" width="16" height="10" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * The one way in, drawn the same everywhere it appears.
 *
 * The promise is written beside the button at every size, including the
 * header, so the offer never becomes a title attribute that a person has to
 * discover.
 */
export function StartTrialButton({
  onStart,
  compact = false,
  className = "",
}: {
  onStart: () => void;
  compact?: boolean;
  className?: string;
}) {
  const t = useTranslations("hub.trial");
  const button = (
    <Button tone="primary" onClick={onStart} title={t("free")} className={className}>
      <SparkGlyph />
      {t("start")}
    </Button>
  );
  return (
    <div className={`ol-trial-cta${compact ? " ol-trial-cta-compact" : ""}`}>
      {button}
      <p>{t("free")}</p>
    </div>
  );
}

/* --------------------------------------------------------------- the wizard */

export function TrialWizard({
  client,
  onStarted,
  onClose,
}: {
  client: SupabaseClient;
  /** The refreshed entitlement, so the hub redraws without a reload. */
  onStarted: (entitlement: ProEntitlement | null) => void;
  onClose: () => void;
}) {
  const t = useTranslations("hub.trial");
  const [complete, setComplete] = useState(false);
  const [push, setPush] = useState<PushOutcome | null>(null);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<TrialFailure | null>(null);
  /**
   * The in flight guard.
   *
   * State alone cannot hold this: two presses inside one React batch both read
   * the old value and both send a request. A ref is written the instant the
   * first press is handled, so the second returns before it reaches the
   * network. The disabled attribute is the visible half of the same rule.
   */
  const inFlight = useRef(false);

  const finish = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setFailure(null);
    const pushResult = push === null
      ? subscribeBrowserPush()
      : Promise.resolve(push);
    void pushResult.then(
      (outcome) => {
        setPush(outcome);
        return startProTrial(client, outcome.state === "granted" ? { push: outcome.subscription } : {});
      },
    ).then(
      (result) => {
        inFlight.current = false;
        setStarting(false);
        if (!result.ok) {
          setFailure(result.reason);
          return;
        }
        onStarted(result.value);
        setComplete(true);
        onClose();
      },
      () => {
        inFlight.current = false;
        setStarting(false);
        setFailure("unavailable");
      },
    );
  }, [client, onClose, onStarted, push]);

  return (
    <section className="ol-onboarding" aria-label={t("label")}>
      <BandHorizon />
      <div className="ol-onboarding-card ol-trial-card" data-step={complete ? "done" : "start"}>

        {!complete && (
          <>
            <div className="ol-onboarding-head">
              <h2>{t("title")}</h2>
              <p>{t("lead")}</p>
            </div>
            <p className="ol-trial-note ol-trial-profile">{t("profile")}</p>
            <p className="ol-trial-note ol-trial-free">{t("free")}</p>
            <p className="ol-trial-note">{t("push.optional")}</p>
            {failure !== null && (
              <p className="ol-trial-error" role="alert">
                {t(`error.${failure}`)}
              </p>
            )}
            <div className="ol-onboarding-actions">
              <Button tone="primary" onClick={finish} disabled={starting}>
                {starting ? t("push.working") : failure === null ? t("start") : t("error.retry")}
              </Button>
            </div>
          </>
        )}

        {complete && (
          <>
            <div className="ol-onboarding-head">
              <h2>{t("done.title")}</h2>
            </div>
            <p className="ol-trial-note" data-state="done">
              {t("done.lead")}
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- the lock */

/** The four services a fresh account can open. */
const PRO_SURFACES = ["alerts", "history", "phone", "multiAccount"] as const;

/**
 * What a locked Pro surface looks like, before a trial and after one.
 *
 * The same card draws both, because they are the same four services seen from
 * two sides: what somebody has not had yet, and what stopped. Only the verbs
 * and the action change, which is the honest difference between them.
 *
 * The offer is a window, not a price change. While `offer_ends_at` is in the
 * future the card carries the countdown and the discounted year; the minute it
 * passes the card falls back to the ordinary prices with no second condition to
 * forget, because the countdown answers null and null is the fallback.
 */
export function ProLockCard({
  client,
  entitlement,
  onStartTrial,
  now,
}: {
  client: SupabaseClient | null;
  entitlement: ProEntitlement | null;
  onStartTrial: () => void;
  /** A frozen clock, for a fixture. Live everywhere else. */
  now?: number;
}) {
  const t = useTranslations("hub.pro");
  const state: ProAccessState = proAccessState(entitlement, now);
  const countdown = useOfferCountdown(entitlement?.offerEndsAt ?? null, now);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

  const locked = locksPro(state);
  const offering = offersTrial(state);

  const checkout = useCallback(
    (discounted: boolean) => {
      if (client === null || inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setFailed(false);
      const call = discounted ? startOfferCheckout(client) : startProCheckout(client, "year");
      void call.then(
        (result) => {
          if (result.ok && isAllowedCheckoutUrl(result.value)) {
            window.location.assign(result.value);
            return;
          }
          inFlight.current = false;
          setBusy(false);
          setFailed(true);
        },
        () => {
          inFlight.current = false;
          setBusy(false);
          setFailed(true);
        },
      );
    },
    [client],
  );

  /* Nothing to lock and nothing to offer: a running trial and a paid plan both
     have every one of these four, so the card is simply not on the screen. */
  if (!locked && !offering) return null;

  const group = locked ? "expired" : "locked";
  const lines = locked ? "lost" : "feature";

  return (
    <section className="ol-lock" aria-label={t(`${group}.title`)}>
      <BandHorizon tone={locked ? "locked" : "bands"} />
      <div className="ol-lock-inner">
        <div className="ol-lock-head">
          <span className="ol-lock-chip">
            <LockGlyph />
            {t("label")}
          </span>
          <h2>{t(`${group}.title`)}</h2>
          <p>{t(`${group}.lead`)}</p>
        </div>

        {locked ? (
          <ExpiredProSummary client={client} namespace="hub.pro" />
        ) : (
          <ul className="ol-lock-list">
            {PRO_SURFACES.map((surface) => (
              <li key={surface}>
                <span aria-hidden="true" className="ol-lock-dot" />
                {t(`${lines}.${surface}`)}
              </li>
            ))}
          </ul>
        )}

        {offering && <StartTrialButton onStart={onStartTrial} />}

        {locked && countdown !== null && (
          <div className="ol-lock-offer">
            <p className="ol-lock-offer-label">{t("offer.label")}</p>
            <p
              className="ol-lock-countdown"
              aria-label={t("offer.countdownLabel", {
                days: countdown.days,
                hours: countdown.hours,
                minutes: countdown.minutes,
              })}
            >
              {t("offer.countdown", {
                days: countdown.days,
                hours: countdown.hours,
                minutes: countdown.minutes,
              })}
            </p>
            <p className="ol-lock-price">{t("offer.price")}</p>
            <Button tone="primary" onClick={() => checkout(true)} disabled={busy}>
              {busy ? t("offer.working") : t("offer.take")}
            </Button>
          </div>
        )}

        {locked && countdown === null && (
          <div className="ol-lock-offer">
            <p className="ol-lock-price">
              {t("prices.line", { yearly: PRO_YEARLY_PRICE })}
            </p>
            <Button tone="primary" onClick={() => checkout(false)} disabled={busy}>
              {busy ? t("offer.working") : t("prices.take")}
            </Button>
          </div>
        )}

        {failed && (
          <p className="ol-trial-error" role="alert">
            {t("error")}
          </p>
        )}
      </div>
    </section>
  );
}
