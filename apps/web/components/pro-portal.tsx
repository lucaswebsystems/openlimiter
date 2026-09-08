"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyKeepSignedIn,
  createAccountClient,
  readKeepSignedIn,
  resumeAccountClient,
  stopAccountClient,
  writeKeepSignedIn,
} from "@/lib/account-client";
import { clearIntent } from "@/lib/pending-intent";
import {
  openProBilling,
  proAccessState,
  proCanManageBilling,
  proCanUpgrade,
  proCheckoutOutcome,
  proConfigurationReady,
  proTrialDaysLeft,
  readProAccount,
  revokeProDevice,
  startProCheckout,
  type ProAccount,
  type ProBillingInterval,
  type ProCheckoutOutcome,
  type ProDevice,
} from "@/lib/pro";
import {
  locksPro,
  offersTrial,
  startOfferCheckout,
  type OfferCountdown,
} from "@/lib/pro-trial";
import { useOfferCountdown } from "@/lib/use-offer-countdown";
import { PRO_MONTHLY_PRICE, PRO_YEARLY_PRICE } from "@/lib/site";
import { SignInCard } from "./sign-in-card";
import { Button, Chip, SectionPanel } from "./ui";
import { ExpiredProSummary } from "./pro-expired-summary";

/**
 * The Pro portal.
 *
 * One surface, and every state on it is drawn rather than printed: signing in,
 * a trial with days left, a paid plan, a plan that is behind, a plan that has
 * ended, a device list, and the two ways a Stripe checkout can come back. No
 * state here is a bare sentence dropped on the canvas, because a bare sentence
 * is what a reader meets on the worst day of using a paid product.
 *
 * The sign in itself is not drawn here. It is the site's one sign in card,
 * the same component the dashboard gate renders, so the two cannot drift.
 * Every button and panel below is the site's own primitive for the same
 * reason: a second hand rolled button is the one that stops matching.
 *
 * WHAT THE CLIENT DOES NOT DECIDE
 * -------------------------------
 * It never starts a trial. The server writes the trial row at first sign in and
 * this page reads it back, so a browser with a wrong clock, an old bundle or a
 * replayed request cannot grant itself anything. The same rule covers the plan
 * state, the features and the device cap: all of them are read, none computed.
 */

type AccountState = "loading" | "ready" | "error";
type Action = "none" | "month" | "year" | "billing" | "offer";

/**
 * Where the trial actually happens.
 *
 * This page offers it and the hub runs it. That is deliberate: there is one
 * wizard, on the surface that has the bars it is about, and a second copy of it
 * here would be a second place for the one call that starts a trial to be made
 * from. The address carries the parameter the desktop tray uses, so the button
 * on this page and the entry in the tray menu are the same door.
 */
const TRIAL_DEEP_LINK = "/app?trial=1";

function formatDate(value: string | null, locale: string): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);
}

/* The one chip on this page: a plan state, spelled out in capitals. */
const STATE_CHIP = "uppercase tracking-wider";

export function ProPortal({ locale }: { locale: string }) {
  const t = useTranslations("proPortal");
  /* Read once, on the first render that has a browser to read from. The panel
     on screen at that moment is the loading one, which says nothing about this
     value, so there is no server rendered answer for it to disagree with. */
  const [keepSignedIn, setKeepSignedIn] = useState(() => readKeepSignedIn());
  /* Rebuilt when the switch moves, because the store a session lands in is
     fixed at construction. See lib/account-client.ts. */
  const supabase = useMemo(
    () => (proConfigurationReady ? createAccountClient(keepSignedIn) : null),
    [keepSignedIn],
  );
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [account, setAccount] = useState<ProAccount | null>(null);
  const [accountState, setAccountState] = useState<AccountState>("loading");
  const [action, setAction] = useState<Action>("none");
  const [actionFailed, setActionFailed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<ProCheckoutOutcome>(null);
  /** The live auth listener, so a client being replaced takes its own with it. */
  const authListener = useRef<{ unsubscribe: () => void } | null>(null);
  /**
   * The offer's remaining time, read above every early return.
   *
   * It has to be here rather than inside the panel that draws it, because two
   * decisions depend on it and they must not disagree: whether the discounted
   * panel is on screen, and whether the ordinary prices are. A page left open
   * across the closing instant redraws on the same minute tick and moves both.
   */
  const offerCountdown = useOfferCountdown(account?.entitlement?.offerEndsAt ?? null);

  /* The checkout return, read once and then cleaned out of the address bar so a
     refresh does not replay a state that has already been acknowledged. */
  useEffect(() => {
    const outcome = proCheckoutOutcome(window.location.search);
    if (outcome === null) return;
    setCheckout(outcome);
    const url = new URL(window.location.href);
    url.searchParams.delete("checkout");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  /** Listen to one client, and be able to attach again after a failed move. */
  const attachAuthListener = useCallback((client: SupabaseClient) => {
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (next === null) clearIntent();
    });
    authListener.current = data.subscription;
  }, []);

  useEffect(() => {
    if (supabase === null) {
      setSession(null);
      return;
    }
    let live = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (live) setSession(data.session);
    });
    attachAuthListener(supabase);
    return () => {
      live = false;
      /* The switch may already have dropped it; unsubscribing twice is safe. */
      authListener.current?.unsubscribe();
      authListener.current = null;
    };
  }, [attachAuthListener, supabase]);

  /**
   * The same handover the dashboard makes, and for the same reason: two clients
   * refreshing one refresh token is a race whose loser signs the reader out.
   * See lib/account-client.ts.
   */
  const changeKeepSignedIn = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (next === keepSignedIn) return true;
      await stopAccountClient(supabase);
      authListener.current?.unsubscribe();
      authListener.current = null;
      if (!applyKeepSignedIn(next)) {
        await resumeAccountClient(supabase);
        if (supabase !== null) attachAuthListener(supabase);
        return false;
      }
      writeKeepSignedIn(next);
      setKeepSignedIn(next);
      return true;
    },
    [attachAuthListener, keepSignedIn, supabase],
  );

  const loadAccount = useCallback(() => {
    if (supabase === null || session === null || session === undefined) return;
    setAccountState("loading");
    void readProAccount(supabase).then((result) => {
      if (result.ok) {
        setAccount(result.value);
        setAccountState("ready");
      } else {
        setAccountState("error");
      }
    });
  }, [session, supabase]);

  useEffect(loadAccount, [loadAccount]);

  async function upgrade(interval: ProBillingInterval) {
    if (supabase === null) return;
    setAction(interval === "month" ? "month" : "year");
    setActionFailed(false);
    const result = await startProCheckout(supabase, interval);
    if (result.ok) {
      window.location.assign(result.value);
      return;
    }
    setAction("none");
    setActionFailed(true);
  }

  async function takeOffer() {
    if (supabase === null || action !== "none") return;
    setAction("offer");
    setActionFailed(false);
    const result = await startOfferCheckout(supabase);
    if (result.ok) {
      window.location.assign(result.value);
      return;
    }
    setAction("none");
    setActionFailed(true);
  }

  async function manageBilling() {
    if (supabase === null) return;
    setAction("billing");
    setActionFailed(false);
    const result = await openProBilling(supabase);
    if (result.ok) {
      window.location.assign(result.value);
      return;
    }
    setAction("none");
    setActionFailed(true);
  }

  async function revoke(device: ProDevice) {
    if (supabase === null) return;
    setRevoking(device.deviceId);
    const result = await revokeProDevice(supabase, device.deviceId);
    setRevoking(null);
    if (result.ok) loadAccount();
    else setActionFailed(true);
  }

  if (supabase === null) {
    return (
      <SectionPanel className="mx-auto w-full max-w-md">
        <h2 className="text-lg font-medium text-heading">{t("configMissing.title")}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{t("configMissing.body")}</p>
      </SectionPanel>
    );
  }

  if (session === undefined) {
    return (
      <SectionPanel className="mx-auto w-full max-w-md">
        <p className="text-sm text-muted" role="status">
          {t("loading")}
        </p>
      </SectionPanel>
    );
  }

  if (session === null) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        {checkout !== null && <CheckoutNotice outcome={checkout} onDismiss={() => setCheckout(null)} />}
        <SignInCard
          client={supabase}
          heading="h2"
          keepSignedIn={keepSignedIn}
          onKeepSignedInChange={changeKeepSignedIn}
        />
      </div>
    );
  }

  const entitlement = account?.entitlement ?? null;
  const state = proAccessState(entitlement);
  const daysLeft = proTrialDaysLeft(entitlement);
  const devices = (account?.devices ?? []).filter((device) => !device.revoked);
  const renews = formatDate(entitlement?.currentPeriodEnd ?? null, locale);
  const trialEnds = formatDate(entitlement?.trialEndsAt ?? null, locale);
  /* Nothing here starts a trial. The button below is a link to the wizard, and
     the wizard is the only caller of start_trial in this application. */
  const canStartTrial = accountState === "ready" && offersTrial(state);
  const locked = accountState === "ready" && locksPro(state);
  /* One price on the screen at a time. While the discounted year is live it is
     the only offer; the ordinary panel is what the closed window falls back
     to, which is the same rule the hub's lock card holds. */
  const offerLive = locked && offerCountdown !== null;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {checkout !== null && <CheckoutNotice outcome={checkout} onDismiss={() => setCheckout(null)} />}

      <SectionPanel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-muted">{t("account.signedInAs")}</p>
            <p className="truncate text-base font-medium text-heading">
              {session.user.email ?? t("account.noEmail")}
            </p>
          </div>
          <Chip
            tone={state === "active" || state === "trial" ? "accent" : "neutral"}
            dot
            className={STATE_CHIP}
          >
            {t(`plan.${state}.chip`)}
          </Chip>
        </div>

        {accountState === "loading" && (
          <p className="mt-6 text-sm text-muted" role="status">
            {t("loading")}
          </p>
        )}

        {accountState === "error" && (
          <div className="mt-6 rounded-xl border border-hairline bg-raised p-5">
            <p className="text-sm font-medium text-heading">{t("accountError.title")}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{t("accountError.body")}</p>
            <Button tone="ghost" onClick={loadAccount} className="mt-4">
              {t("accountError.retry")}
            </Button>
          </div>
        )}

        {accountState === "ready" && (
          <div className="mt-6 space-y-3">
            <h2 className="text-lg font-medium text-heading">{t(`plan.${state}.title`)}</h2>
            <p className="text-sm leading-relaxed text-muted">{t(`plan.${state}.body`)}</p>
            {state === "trial" && daysLeft !== null && (
              <p className="text-sm leading-relaxed text-body">
                {t("plan.trial.daysLeft", { count: daysLeft })}
                {trialEnds === null ? "" : ` ${t("plan.trial.ends", { date: trialEnds })}`}
              </p>
            )}
            {state === "active" && renews !== null && (
              <p className="text-sm leading-relaxed text-body">
                {entitlement?.cancelAtPeriodEnd === true
                  ? t("plan.active.endsOn", { date: renews })
                  : t("plan.active.renewsOn", { date: renews })}
              </p>
            )}
          </div>
        )}
      </SectionPanel>

      {canStartTrial && (
        <SectionPanel className="border-accent-subtle">
          <h2 className="text-lg font-medium text-heading">{t("trial.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("trial.body")}</p>
          <Button
            tone="accent"
            className="mt-5"
            title={t("trial.free")}
            onClick={() => window.location.assign(TRIAL_DEEP_LINK)}
          >
            {t("trial.start")}
          </Button>
          <p className="mt-3 text-sm font-medium text-body">{t("trial.free")}</p>
        </SectionPanel>
      )}

      {locked && (
        <OfferPanel
          client={supabase}
          countdown={offerCountdown}
          working={action === "offer"}
          disabled={action !== "none"}
          onTake={() => void takeOffer()}
        />
      )}

      {accountState === "ready" && proCanUpgrade(state) && !canStartTrial && !offerLive && (
        <SectionPanel>
          <h2 className="text-lg font-medium text-heading">{t("upgrade.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("upgrade.body")}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button tone="primary" disabled={action !== "none"} onClick={() => void upgrade("month")}>
              {action === "month"
                ? t("working")
                : t("upgrade.monthly", { price: PRO_MONTHLY_PRICE })}
            </Button>
            <Button tone="ghost" disabled={action !== "none"} onClick={() => void upgrade("year")}>
              {action === "year" ? t("working") : t("upgrade.yearly", { price: PRO_YEARLY_PRICE })}
            </Button>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-muted">{t("upgrade.note")}</p>
        </SectionPanel>
      )}

      {accountState === "ready" && proCanManageBilling(state) && (
        <SectionPanel>
          <h2 className="text-lg font-medium text-heading">{t("billing.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("billing.body")}</p>
          <Button
            tone="primary"
            disabled={action !== "none"}
            onClick={() => void manageBilling()}
            className="mt-5"
          >
            {action === "billing" ? t("working") : t("billing.manage")}
          </Button>
        </SectionPanel>
      )}

      {accountState === "ready" && (
        <SectionPanel>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-medium text-heading">{t("devices.title")}</h2>
            <p className="text-sm text-muted">
              {t("devices.count", {
                count: devices.length,
                cap: entitlement?.deviceCap ?? 5,
              })}
            </p>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("devices.body")}</p>

          {devices.length === 0 ? (
            <p className="mt-5 rounded-xl border border-hairline bg-raised p-5 text-sm text-muted">
              {t("devices.empty")}
            </p>
          ) : (
            <ul className="mt-5 space-y-2">
              {devices.map((device) => (
                <li
                  key={device.deviceId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-raised px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium text-heading">
                      {device.label}
                      {device.isCurrent && (
                        <Chip tone="strong" dot className={STATE_CHIP}>
                          {t("devices.current")}
                        </Chip>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {device.lastSeenAt === null
                        ? t("devices.neverSeen")
                        : t("devices.lastSeen", {
                            date: formatDate(device.lastSeenAt, locale) ?? "",
                          })}
                    </p>
                  </div>
                  <Button tone="ghost" disabled={revoking !== null} onClick={() => void revoke(device)}>
                    {revoking === device.deviceId ? t("working") : t("devices.revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SectionPanel>
      )}

      {actionFailed && (
        <SectionPanel>
          <p className="text-sm font-medium text-heading">{t("actionError.title")}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">{t("actionError.body")}</p>
        </SectionPanel>
      )}

      <div className="flex justify-end">
        <Button tone="quiet" onClick={() => { clearIntent(); void supabase.auth.signOut(); }}>
          {t("signOut")}
        </Button>
      </div>
    </div>
  );
}

/**
 * What a trial that has ended is offered, while the window is open.
 *
 * Four lines saying what stopped, a countdown, and one price. The countdown is
 * the server's own `offer_ends_at` and nothing else: when it answers null the
 * whole panel is gone and the ordinary upgrade panel below it is the offer, so
 * the closed state is the absence of this rather than a second set of prices
 * somebody has to remember to write.
 */
function OfferPanel({
  client,
  countdown,
  working,
  disabled,
  onTake,
}: {
  client: SupabaseClient;
  /** Null once the window has closed, which is what removes the price. */
  countdown: OfferCountdown | null;
  working: boolean;
  disabled: boolean;
  onTake: () => void;
}) {
  const t = useTranslations("proPortal");

  return (
    <SectionPanel className="border-accent-subtle">
      <ExpiredProSummary client={client} namespace="proPortal" />

      {countdown !== null && (
        <>
          <h2 className="mt-6 text-lg font-medium text-heading">{t("offer.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("offer.lead")}</p>
          <p className="mt-5 text-xs uppercase tracking-wider text-soft">{t("offer.label")}</p>
          <p
            className="mt-1 font-mono text-3xl tabular-nums text-heading"
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
          <p className="mt-3 text-sm leading-relaxed text-body">{t("offer.price")}</p>
          <Button tone="accent" className="mt-5" disabled={disabled} onClick={onTake}>
            {working ? t("working") : t("offer.take")}
          </Button>
        </>
      )}
    </SectionPanel>
  );
}

function CheckoutNotice({
  outcome,
  onDismiss,
}: {
  outcome: Exclude<ProCheckoutOutcome, null>;
  onDismiss: () => void;
}) {
  const t = useTranslations("proPortal.checkout");
  return (
    <SectionPanel className="border-accent-subtle">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-medium text-heading">{t(`${outcome}.title`)}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t(`${outcome}.body`)}</p>
        </div>
        <Button tone="quiet" onClick={onDismiss}>
          {t("dismiss")}
        </Button>
      </div>
    </SectionPanel>
  );
}
