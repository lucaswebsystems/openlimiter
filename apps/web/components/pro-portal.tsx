"use client";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  type ProAccount,
  type ProBillingInterval,
  type ProCheckoutOutcome,
  type ProDevice,
} from "@/lib/pro";
import { PRO_MONTHLY_PRICE, PRO_YEARLY_PRICE } from "@/lib/site";
import { SignInCard } from "./sign-in-card";
import { Button, Chip, SectionPanel } from "./ui";

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

/* ------------------------------------------------------------------ client */

function client(): SupabaseClient | null {
  if (!proConfigurationReady) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

type AccountState = "loading" | "ready" | "error";
type Action = "none" | "month" | "year" | "billing";

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
  const supabase = useMemo(client, []);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [account, setAccount] = useState<ProAccount | null>(null);
  const [accountState, setAccountState] = useState<AccountState>("loading");
  const [action, setAction] = useState<Action>("none");
  const [actionFailed, setActionFailed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<ProCheckoutOutcome>(null);

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

  useEffect(() => {
    if (supabase === null) {
      setSession(null);
      return;
    }
    let live = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (live) setSession(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

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
        <SignInCard client={supabase} heading="h2" />
      </div>
    );
  }

  const entitlement = account?.entitlement ?? null;
  const state = proAccessState(entitlement);
  const daysLeft = proTrialDaysLeft(entitlement);
  const devices = (account?.devices ?? []).filter((device) => !device.revoked);
  const renews = formatDate(entitlement?.currentPeriodEnd ?? null, locale);
  const trialEnds = formatDate(entitlement?.trialEndsAt ?? null, locale);

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

      {accountState === "ready" && proCanUpgrade(state) && (
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
        <Button tone="quiet" onClick={() => void supabase.auth.signOut()}>
          {t("signOut")}
        </Button>
      </div>
    </div>
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
