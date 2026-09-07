"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { BandHorizon } from "./horizon";
import { Button } from "./pieces";
import { subscribeBrowserPush, type PushOutcome } from "@/lib/pro-notifications";
import { proAccessState, startProCheckout, type ProAccessState, type ProEntitlement } from "@/lib/pro";
import {
  TRIAL_ALERT_THRESHOLDS,
  isAllowedCheckoutUrl,
  locksPro,
  offersTrial,
  startOfferCheckout,
  startProTrial,
  type TrialFailure,
} from "@/lib/pro-trial";
import { useOfferCountdown } from "@/lib/use-offer-countdown";
import { PRO_YEARLY_PRICE } from "@/lib/site";

/**
 * The trial, the wizard that starts it, and the lock that follows it.
 *
 * THE SIGNATURE MOMENT IS THE THRESHOLD LADDER
 * --------------------------------------------
 * The first step of the wizard does not ask about alerts with three checkboxes.
 * It draws them: sixty, eighty and ninety percent as three real meters at
 * exactly those widths, in exactly the band colours the product paints a window
 * that deep, and switching one off drains its fill back to the track. Somebody
 * setting an alert at ninety is looking at what ninety looks like, in the same
 * language every bar on the next screen speaks. It is the band horizon's own
 * family, one level closer to the reader: the horizon says what this screen is
 * for, the ladder says what this switch means.
 *
 * THE CARD IS THE FIRST RUN CARD
 * ------------------------------
 * Same shell, same rail, same action metrics as the three onboarding screens,
 * because it is the same kind of moment and a second card shape would be the
 * one that stops matching. Only what is genuinely new here is new: the ladder,
 * the push state and the lock.
 *
 * NOTHING IS WRITTEN UNTIL FINISH
 * -------------------------------
 * Thresholds, the reset switch and the push subscription are held in this
 * component and travel in the single call that starts the trial. Somebody who
 * grants push and then closes the card has given the server nothing, and a
 * second press while that call is in flight is ignored rather than queued, so
 * one wizard is one trial however hard the button is pressed.
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
 * Compact is the header: the button alone, with the promise as its title,
 * because a sentence in a toolbar is a sentence nobody reads. Everywhere else
 * the promise is under the button in full, because that is the whole offer and
 * it costs one line.
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
  if (compact) return button;
  return (
    <div className="ol-trial-cta">
      {button}
      <p>{t("free")}</p>
    </div>
  );
}

/* --------------------------------------------------------------- the ladder */

/** Which band a threshold is painted in. The meters' own answer, not a new one. */
const THRESHOLD_BAND: Record<number, string> = { 60: "yellow", 80: "orange", 90: "red" };

function LadderRow({
  label,
  band,
  threshold,
  checked,
  onChange,
}: {
  label: string;
  band: string;
  /** Drives the fill width in CSS, so no reading is ever an inline style. */
  threshold: number;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="ol-ladder-row focus-ring"
      data-band={band}
      data-threshold={threshold}
    >
      <span className="ol-ladder-label">{label}</span>
      <span aria-hidden="true" className="ol-ladder-track">
        <span className="ol-ladder-fill" />
      </span>
    </button>
  );
}

/* --------------------------------------------------------------- the wizard */

const STEPS = ["alerts", "push", "done"] as const;
type WizardStep = (typeof STEPS)[number];

function formatDate(value: string | null, locale: string): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);
}

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
  const locale = useLocale();
  const [step, setStep] = useState<WizardStep>("alerts");
  const [thresholds, setThresholds] = useState<number[]>([...TRIAL_ALERT_THRESHOLDS]);
  const [reset, setReset] = useState(true);
  const [push, setPush] = useState<PushOutcome | null>(null);
  const [asking, setAsking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<TrialFailure | null>(null);
  const [endsAt, setEndsAt] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const lastStep = useRef<WizardStep>(step);
  /**
   * The in flight guard.
   *
   * State alone cannot hold this: two presses inside one React batch both read
   * the old value and both send a request. A ref is written the instant the
   * first press is handled, so the second returns before it reaches the
   * network. The disabled attribute is the visible half of the same rule.
   */
  const inFlight = useRef(false);

  const index = STEPS.indexOf(step);

  useEffect(() => {
    if (lastStep.current === step) return;
    lastStep.current = step;
    heading.current?.focus();
  }, [step]);

  const toggle = useCallback((threshold: number, next: boolean) => {
    setThresholds((current) =>
      next
        ? [...current, threshold].sort((left, right) => left - right)
        : current.filter((value) => value !== threshold),
    );
  }, []);

  const ask = useCallback(() => {
    if (asking) return;
    setAsking(true);
    void subscribeBrowserPush().then(
      (outcome) => {
        setPush(outcome);
        setAsking(false);
      },
      () => {
        setPush({ state: "unsupported" });
        setAsking(false);
      },
    );
  }, [asking]);

  const finish = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setFailure(null);
    void startProTrial(client, {
      alerts: { thresholds, reset },
      ...(push !== null && push.state === "granted" ? { push: push.subscription } : {}),
    }).then(
      (result) => {
        inFlight.current = false;
        setStarting(false);
        if (!result.ok) {
          setFailure(result.reason);
          return;
        }
        setEndsAt(result.value?.trialEndsAt ?? null);
        onStarted(result.value);
        setStep("done");
      },
      () => {
        inFlight.current = false;
        setStarting(false);
        setFailure("unavailable");
      },
    );
  }, [client, onStarted, push, reset, thresholds]);

  const ends = formatDate(endsAt, locale);

  return (
    <section className="ol-onboarding" aria-label={t("label")}>
      <BandHorizon />
      <div className="ol-onboarding-card ol-trial-card" data-step={step}>
        <div className="ol-onboarding-rail" aria-hidden="true">
          {STEPS.map((id, position) => (
            <span
              key={id}
              data-state={position < index ? "done" : position === index ? "here" : undefined}
            />
          ))}
        </div>
        <p role="status" aria-live="polite" className="sr-only">
          {t("progress", { step: index + 1, total: STEPS.length })}
        </p>

        {step === "alerts" && (
          <>
            <div className="ol-onboarding-head">
              <h2 ref={heading} tabIndex={-1}>
                {t("alerts.title")}
              </h2>
              <p>{t("alerts.lead")}</p>
            </div>
            <div className="ol-ladder">
              {TRIAL_ALERT_THRESHOLDS.map((threshold) => (
                <LadderRow
                  key={threshold}
                  label={t("alerts.threshold", { percent: threshold })}
                  band={THRESHOLD_BAND[threshold] ?? "green"}
                  threshold={threshold}
                  checked={thresholds.includes(threshold)}
                  onChange={(next) => toggle(threshold, next)}
                />
              ))}
              <LadderRow
                label={t("alerts.reset")}
                band="green"
                threshold={0}
                checked={reset}
                onChange={setReset}
              />
            </div>
            <div className="ol-onboarding-actions">
              <Button tone="primary" onClick={() => setStep("push")}>
                {t("alerts.continue")}
              </Button>
              <Button tone="quiet" onClick={onClose}>
                {t("cancel")}
              </Button>
            </div>
          </>
        )}

        {step === "push" && (
          <>
            <div className="ol-onboarding-head">
              <h2 ref={heading} tabIndex={-1}>
                {t("push.title")}
              </h2>
              <p>{t("push.lead")}</p>
            </div>
            <div className="ol-trial-push">
              {push === null ? (
                <Button tone="ghost" onClick={ask} disabled={asking}>
                  {t("push.ask")}
                </Button>
              ) : (
                <p className="ol-trial-note" data-state={push.state} role="status">
                  {push.state === "granted"
                    ? t("push.granted")
                    : push.state === "denied"
                      ? t("push.denied")
                      : t("push.unsupported")}
                </p>
              )}
            </div>
            {failure !== null && (
              <p className="ol-trial-error" role="alert">
                {t(`error.${failure}`)}
              </p>
            )}
            <div className="ol-onboarding-actions">
              <Button tone="primary" onClick={finish} disabled={starting}>
                {starting ? t("push.working") : failure === null ? t("push.start") : t("error.retry")}
              </Button>
              <Button tone="quiet" onClick={() => setStep("alerts")} disabled={starting}>
                {t("back")}
              </Button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <div className="ol-onboarding-head">
              <h2 ref={heading} tabIndex={-1}>
                {t("done.title")}
              </h2>
              <p>{ends === null ? t("done.endsUnknown") : t("done.ends", { date: ends })}</p>
            </div>
            <p className="ol-trial-note" data-state="done">
              {t("done.lead")}
            </p>
            <div className="ol-onboarding-actions">
              <Button tone="primary" onClick={onClose}>
                {t("done.bars")}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- the lock */

/** The four services an account holds or has lost. One line each, in order. */
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

        <ul className="ol-lock-list">
          {PRO_SURFACES.map((surface) => (
            <li key={surface}>
              <span aria-hidden="true" className="ol-lock-dot" />
              {t(`${lines}.${surface}`)}
            </li>
          ))}
        </ul>

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
