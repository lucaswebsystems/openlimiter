"use client";

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { proConfigurationReady, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/pro";

function client(): SupabaseClient | null {
  if (!proConfigurationReady) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

export function ProPortal() {
  const t = useTranslations("proPortal");
  const supabase = useMemo(client, []);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (supabase === null) return;
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

  useEffect(() => {
    if (supabase === null || session === null) return;
    void supabase.functions
      .invoke("pro-service", { body: { action: "account_status" } })
      .then(({ error }) => {
        if (error === null) setMessage(t("trialActive"));
      });
  }, [session, supabase, t]);

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (supabase === null || email.trim() === "") return;
    setBusy(true);
    setMessage("");
    const redirect = window.location.href.split("?")[0];
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: redirect },
    });
    setBusy(false);
    setMessage(error === null ? t("linkSent") : t("error"));
  }

  async function checkout(interval: "month" | "year") {
    if (supabase === null) return;
    setBusy(true);
    setMessage("");
    const { data, error } = await supabase.functions.invoke("create-checkout", {
      body: { interval },
    });
    if (error !== null || typeof data?.url !== "string") {
      setBusy(false);
      setMessage(t("error"));
      return;
    }
    window.location.assign(data.url);
  }

  async function signOut() {
    if (supabase === null) return;
    setBusy(true);
    await supabase.auth.signOut();
    setBusy(false);
    setMessage("");
  }

  if (supabase === null) {
    return (
      <div className="rounded-2xl border border-hairline bg-surface p-6 text-sm text-muted">
        {t("configMissing")}
      </div>
    );
  }

  if (session === null) {
    return (
      <form
        onSubmit={sendLink}
        className="mx-auto max-w-xl space-y-5 rounded-2xl border border-hairline bg-surface p-6 md:p-8"
      >
        <label className="block space-y-2 text-sm font-medium text-heading" htmlFor="pro-email">
          <span>{t("emailLabel")}</span>
          <input
            id="pro-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("emailPlaceholder")}
            className="focus-ring w-full rounded-lg border border-hairline-strong bg-canvas px-4 py-3 text-body"
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="focus-ring w-full rounded-lg bg-solid px-4 py-3 text-sm font-medium text-on-solid disabled:opacity-60"
        >
          {busy ? t("working") : t("sendLink")}
        </button>
        <p className="text-sm text-muted">{message || t("privacy")}</p>
      </form>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 rounded-2xl border border-hairline bg-surface p-6 md:p-8">
      <div className="space-y-2">
        <p className="text-sm font-medium text-heading">{t("signedIn")}</p>
        <p className="text-sm text-muted">{message || t("trialActive")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void checkout("month")}
          className="focus-ring rounded-lg bg-solid px-4 py-3 text-sm font-medium text-on-solid disabled:opacity-60"
        >
          {t("checkoutMonthly")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void checkout("year")}
          className="focus-ring rounded-lg border border-hairline-strong px-4 py-3 text-sm font-medium text-heading disabled:opacity-60"
        >
          {t("checkoutYearly")}
        </button>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void signOut()}
        className="focus-ring text-sm text-muted underline underline-offset-4"
      >
        {t("signOut")}
      </button>
    </div>
  );
}
