"use client";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
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

/**
 * The Pro portal.
 *
 * One surface, and every state on it is drawn rather than printed: signing in,
 * a trial with days left, a paid plan, a plan that is behind, a plan that has
 * ended, a device list, and the two ways a Stripe checkout can come back. No
 * state here is a bare sentence dropped on the canvas, because a bare sentence
 * is what a reader meets on the worst day of using a paid product.
 *
 * WHAT THE CLIENT DOES NOT DECIDE
 * -------------------------------
 * It never starts a trial. The server writes the trial row at first sign in and
 * this page reads it back, so a browser with a wrong clock, an old bundle or a
 * replayed request cannot grant itself anything. The same rule covers the plan
 * state, the features and the device cap: all of them are read, none computed.
 */

/* -------------------------------------------------------------- primitives */

const BUTTON_BASE =
  "lift-sm focus-ring inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60";
const BUTTON_PRIMARY = "border-transparent bg-solid text-on-solid hover:bg-solid-hover";
const BUTTON_GHOST =
  "border-hairline-strong bg-transparent text-heading hover:border-heading hover:bg-surface";
const BUTTON_QUIET = "border-transparent text-muted hover:text-heading";
const PANEL =
  "elev-1 relative overflow-hidden rounded-2xl border border-hairline bg-surface p-6 md:p-8";
const FIELD =
  "focus-ring w-full rounded-lg border border-hairline-strong bg-canvas px-4 py-3 text-sm text-body";

function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`${PANEL} ${className}`}>
      <span aria-hidden="true" className="hairline-sheen" />
      {children}
    </div>
  );
}

function StateChip({
  tone,
  children,
}: {
  tone: "accent" | "neutral" | "strong";
  children: ReactNode;
}) {
  const tint =
    tone === "accent"
      ? "border-accent-subtle bg-accent-subtle text-accent"
      : tone === "strong"
        ? "border-hairline bg-raised text-heading"
        : "border-hairline bg-surface text-muted";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium uppercase tracking-wider ${tint}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 flex-none rounded-full ${tone === "accent" ? "bg-accent-solid" : tone === "strong" ? "bg-heading" : "bg-muted"}`}
      />
      {children}
    </span>
  );
}

function GitHubMark() {
  return (
    <svg className="h-4 w-4 flex-none fill-current" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

/**
 * Google's mark, served as the file Google publishes rather than redrawn here.
 *
 * It keeps its own four colours because a provider mark is used unmodified, and
 * it stays out of this file so no brand colour is ever written as a literal in
 * a component. See public/brand/google-g.svg.
 */
function GoogleMark() {
  /* eslint-disable-next-line @next/next/no-img-element -- a brand mark served
     verbatim, at its intrinsic size, with no optimisation pass over it. */
  return <img src="/brand/google-g.svg" alt="" aria-hidden="true" className="h-4 w-4 flex-none" />;
}

/* ------------------------------------------------------------------ client */

function client(): SupabaseClient | null {
  if (!proConfigurationReady) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

type SignInMode = "idle" | "working" | "sent" | "error";
type AccountState = "loading" | "ready" | "error";
type Action = "none" | "month" | "year" | "billing";

function formatDate(value: string | null, locale: string): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed);
}

export function ProPortal({ locale }: { locale: string }) {
  const t = useTranslations("proPortal");
  const supabase = useMemo(client, []);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [signInMode, setSignInMode] = useState<SignInMode>("idle");
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

  async function oauth(provider: "github" | "google") {
    if (supabase === null) return;
    setSignInMode("working");
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.href.split("?")[0] },
    });
    if (error !== null) setSignInMode("error");
  }

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (supabase === null || email.trim() === "") return;
    setSignInMode("working");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.href.split("?")[0] },
    });
    setSignInMode(error === null ? "sent" : "error");
  }

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
      <Panel>
        <h2 className="text-lg font-medium text-heading">{t("configMissing.title")}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">{t("configMissing.body")}</p>
      </Panel>
    );
  }

  if (session === undefined) {
    return (
      <Panel>
        <p className="text-sm text-muted" role="status">
          {t("loading")}
        </p>
      </Panel>
    );
  }

  if (session === null) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        {checkout !== null && <CheckoutNotice outcome={checkout} onDismiss={() => setCheckout(null)} />}
        <Panel>
          <h2 className="text-lg font-medium text-heading">{t("signIn.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("signIn.body")}</p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              disabled={signInMode === "working"}
              onClick={() => void oauth("github")}
              className={`${BUTTON_BASE} ${BUTTON_PRIMARY}`}
            >
              <GitHubMark />
              {t("signIn.github")}
            </button>
            <button
              type="button"
              disabled={signInMode === "working"}
              onClick={() => void oauth("google")}
              className={`${BUTTON_BASE} ${BUTTON_GHOST}`}
            >
              <GoogleMark />
              {t("signIn.google")}
            </button>
          </div>

          <div className="mt-7 border-t border-hairline pt-6">
            <p className="text-sm font-medium text-heading">{t("signIn.fallbackTitle")}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{t("signIn.fallbackBody")}</p>
            <form onSubmit={sendLink} className="mt-4 space-y-3">
              <label className="block space-y-2 text-sm font-medium text-heading" htmlFor="pro-email">
                <span>{t("signIn.emailLabel")}</span>
                <input
                  id="pro-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder={t("signIn.emailPlaceholder")}
                  className={FIELD}
                />
              </label>
              <button
                type="submit"
                disabled={signInMode === "working"}
                className={`${BUTTON_BASE} ${BUTTON_GHOST} w-full`}
              >
                {signInMode === "working" ? t("working") : t("signIn.send")}
              </button>
            </form>
          </div>

          <p className="mt-5 text-sm leading-relaxed text-muted" role="status">
            {signInMode === "sent"
              ? t("signIn.sent")
              : signInMode === "error"
                ? t("signIn.error")
                : t("signIn.privacy")}
          </p>
        </Panel>
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

      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-muted">{t("account.signedInAs")}</p>
            <p className="truncate text-base font-medium text-heading">
              {session.user.email ?? t("account.noEmail")}
            </p>
          </div>
          <StateChip tone={state === "active" || state === "trial" ? "accent" : "neutral"}>
            {t(`plan.${state}.chip`)}
          </StateChip>
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
            <button
              type="button"
              onClick={loadAccount}
              className={`${BUTTON_BASE} ${BUTTON_GHOST} mt-4`}
            >
              {t("accountError.retry")}
            </button>
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
      </Panel>

      {accountState === "ready" && proCanUpgrade(state) && (
        <Panel>
          <h2 className="text-lg font-medium text-heading">{t("upgrade.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("upgrade.body")}</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              disabled={action !== "none"}
              onClick={() => void upgrade("month")}
              className={`${BUTTON_BASE} ${BUTTON_PRIMARY}`}
            >
              {action === "month"
                ? t("working")
                : t("upgrade.monthly", { price: PRO_MONTHLY_PRICE })}
            </button>
            <button
              type="button"
              disabled={action !== "none"}
              onClick={() => void upgrade("year")}
              className={`${BUTTON_BASE} ${BUTTON_GHOST}`}
            >
              {action === "year" ? t("working") : t("upgrade.yearly", { price: PRO_YEARLY_PRICE })}
            </button>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-muted">{t("upgrade.note")}</p>
        </Panel>
      )}

      {accountState === "ready" && proCanManageBilling(state) && (
        <Panel>
          <h2 className="text-lg font-medium text-heading">{t("billing.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t("billing.body")}</p>
          <button
            type="button"
            disabled={action !== "none"}
            onClick={() => void manageBilling()}
            className={`${BUTTON_BASE} ${BUTTON_PRIMARY} mt-5`}
          >
            {action === "billing" ? t("working") : t("billing.manage")}
          </button>
        </Panel>
      )}

      {accountState === "ready" && (
        <Panel>
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
                      {device.isCurrent && <StateChip tone="strong">{t("devices.current")}</StateChip>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {device.lastSeenAt === null
                        ? t("devices.neverSeen")
                        : t("devices.lastSeen", {
                            date: formatDate(device.lastSeenAt, locale) ?? "",
                          })}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={revoking !== null}
                    onClick={() => void revoke(device)}
                    className={`${BUTTON_BASE} ${BUTTON_GHOST}`}
                  >
                    {revoking === device.deviceId ? t("working") : t("devices.revoke")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      {actionFailed && (
        <Panel>
          <p className="text-sm font-medium text-heading">{t("actionError.title")}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">{t("actionError.body")}</p>
        </Panel>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void supabase.auth.signOut()}
          className={`${BUTTON_BASE} ${BUTTON_QUIET}`}
        >
          {t("signOut")}
        </button>
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
    <Panel className="border-accent-subtle">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-medium text-heading">{t(`${outcome}.title`)}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">{t(`${outcome}.body`)}</p>
        </div>
        <button type="button" onClick={onDismiss} className={`${BUTTON_BASE} ${BUTTON_QUIET}`}>
          {t("dismiss")}
        </button>
      </div>
    </Panel>
  );
}
