"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ConnectList } from "./connect";
import { BandHorizon } from "./horizon";
import { Button } from "./pieces";
import {
  ONBOARDING_STEPS,
  profileEmail,
  profileName,
  profileProviderName,
  type AccountProfile,
  type OnboardingStep,
} from "@/lib/onboarding";

/**
 * The first visit, in three screens.
 *
 * Create your account, connect what you already pay for, see your bars. It is
 * the same three steps the desktop first run and the terminal first run take,
 * drawn here in the browser's own shape, and it happens once: the flag that
 * says so lives on the account, so a second machine does not repeat it.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It writes nothing. Saving a name and recording that the flow is finished are
 * the hub's business, because the hub owns the account client, and a screen
 * that both draws and writes is a screen that cannot be tested without a
 * server. Everything here is a decision about what is on screen.
 *
 * THE LATER LINK IS NOT A DECORATION
 * ----------------------------------
 * Bars are free and the account gates syncing, alerts, the phone and multiple
 * accounts per provider. So the first screen carries a way past itself, and it
 * goes where the reader was going anyway.
 */
export function Onboarding({
  profile,
  bars,
  onSaveName,
  onFinish,
}: {
  profile: AccountProfile | null;
  /** The third screen shows the real thing: the hub's own bars, or its empty state. */
  bars: ReactNode;
  onSaveName: (name: string) => void;
  onFinish: () => void;
}) {
  const t = useTranslations("hub");
  const fieldId = useId();
  const [step, setStep] = useState<OnboardingStep>("profile");
  const heading = useRef<HTMLHeadingElement | null>(null);
  const arrived = useRef(false);
  const [name, setName] = useState(() => profileName(profile));
  const email = profileEmail(profile);
  const provider = profileProviderName(profile);
  const index = ONBOARDING_STEPS.indexOf(step);

  /*
   * Focus follows the step.
   *
   * The button that advanced the flow is unmounted a moment later, and focus
   * left on a removed element falls back to the document: a keyboard reader is
   * returned to the top of the page and a screen reader announces nothing at
   * all. Moving it to the new screen's heading says where they are and leaves
   * the next Tab in the right place. The first screen is left alone, because
   * nobody navigated to it.
   */
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      return;
    }
    heading.current?.focus();
  }, [step]);

  return (
    <section className="ol-onboarding" aria-label={t("onboarding.label")}>
      <BandHorizon />
      <div className="ol-onboarding-card" data-step={step}>
        <div className="ol-onboarding-rail" aria-hidden="true">
          {ONBOARDING_STEPS.map((id, position) => (
            <span
              key={id}
              data-state={position < index ? "done" : position === index ? "here" : undefined}
            />
          ))}
        </div>
        <p role="status" aria-live="polite" className="sr-only">
          {t("onboarding.progress", { step: index + 1, total: ONBOARDING_STEPS.length })}
        </p>

        {step === "profile" && (
          <>
            <div className="ol-onboarding-head">
              <h2 ref={heading} tabIndex={-1}>{t("onboarding.profile.title")}</h2>
              <p>{t("onboarding.profile.lead")}</p>
            </div>
            <div className="ol-onboarding-fields">
              <div className="ol-onboarding-field">
                <label htmlFor={`${fieldId}-name`}>{t("onboarding.profile.name")}</label>
                <input
                  id={`${fieldId}-name`}
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="focus-ring"
                />
              </div>
              <div className="ol-onboarding-field">
                <label htmlFor={`${fieldId}-email`}>{t("onboarding.profile.email")}</label>
                <input
                  id={`${fieldId}-email`}
                  type="email"
                  readOnly
                  value={email}
                  aria-describedby={provider === null ? undefined : `${fieldId}-from`}
                  className="focus-ring"
                />
                {provider !== null && (
                  <p id={`${fieldId}-from`} className="text-xs text-muted">
                    {t("onboarding.profile.emailFrom", { provider })}
                  </p>
                )}
              </div>
            </div>
            <div className="ol-onboarding-actions">
              <Button
                tone="primary"
                onClick={() => {
                  onSaveName(name.trim());
                  setStep("connect");
                }}
              >
                {t("onboarding.profile.continue")}
              </Button>
              <Button tone="quiet" onClick={onFinish}>
                {t("onboarding.profile.later")}
              </Button>
            </div>
          </>
        )}

        {step === "connect" && (
          <>
            <div className="ol-onboarding-head">
              <h2 ref={heading} tabIndex={-1}>{t("connect.title")}</h2>
              <p>{t("connect.lead")}</p>
            </div>
            <ConnectList />
            <div className="ol-onboarding-actions">
              <Button tone="primary" onClick={() => setStep("bars")}>
                {t("onboarding.connect.continue")}
              </Button>
              <Button tone="quiet" onClick={onFinish}>
                {t("onboarding.connect.skip")}
              </Button>
            </div>
          </>
        )}

        {step === "bars" && (
          <>
            <div className="ol-onboarding-head">
              <h2 ref={heading} tabIndex={-1}>{t("onboarding.bars.title")}</h2>
              <p>{t("onboarding.bars.lead")}</p>
            </div>
            {bars}
            <div className="ol-onboarding-actions">
              <Button tone="primary" onClick={onFinish}>
                {t("onboarding.bars.done")}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
