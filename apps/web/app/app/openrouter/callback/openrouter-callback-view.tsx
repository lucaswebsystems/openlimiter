"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { BrandLockup } from "@/components/brand";
import { createAccountClient, readKeepSignedIn, resumeAccountClient, stopAccountClient } from "@/lib/account-client";
import { stripQueryParams } from "@/lib/browser-history";
import { storeCloudKey } from "@/lib/cloud-meter";
import { CONFIGURATION_DEEP_LINK_PARAM } from "@/lib/onboarding";
import {
  exchangeOpenRouterCode,
  openRouterCallbackParams,
  takeOpenRouterVerifier,
} from "@/lib/openrouter-oauth";

/**
 * Where OpenRouter's own login redirects back to.
 *
 * This page does exactly one thing on its own, without being asked: it reads
 * the code OpenRouter's redirect carried, trades it for a key against
 * OpenRouter's documented exchange, and stores that key through
 * `cloud-meter store` under the label "OpenRouter". The verifier PKCE needs
 * for that exchange is read out of session storage once, under the nonce this
 * same browser minted before it left, and removed in that same read: nothing
 * here is a page a reader is meant to return to twice.
 *
 * This component lives outside page.tsx because Next's generated route type
 * check refuses a page module with any export beyond its own whitelist, and
 * separately refuses a default export whose props are anything but
 * `params`/`searchParams`. See app/app/cli/cli-page-view.tsx for the same
 * pattern, first found there.
 */

const CARD = "rounded-2xl border border-hairline bg-surface p-5";

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={CARD} aria-live="polite">
      <h1 className="text-lg font-medium text-heading">{title}</h1>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  );
}

type Phase = "exchanging" | "success" | "error";

export interface OpenRouterCallbackProps {
  client?: SupabaseClient | null;
  session?: Session | null;
  search?: string;
}

export function OpenRouterCallbackView({
  client: propClient,
  session: propSession,
  search,
}: OpenRouterCallbackProps) {
  const t = useTranslations("hub.cloud.callback");
  const syncClient = useMemo(() => propClient !== undefined ? propClient : createAccountClient(readKeepSignedIn()), [propClient]);
  const [session, setSession] = useState<Session | null | undefined>(propSession);
  const [phase, setPhase] = useState<Phase>("exchanging");
  const started = useRef(false);
  const callbackSearch = useMemo(
    () => search ?? (typeof window === "undefined" ? "" : window.location.search),
    [search],
  );
  const callback = useMemo(() => openRouterCallbackParams(callbackSearch), [callbackSearch]);

  useEffect(() => {
    stripQueryParams(["code", "n"]);
  }, []);

  useEffect(() => {
    if (propClient !== undefined) return;
    void resumeAccountClient(syncClient);
    return () => { void stopAccountClient(syncClient); };
  }, [propClient, syncClient]);

  useEffect(() => {
    if (propSession !== undefined) {
      setSession(propSession);
      return undefined;
    }
    if (syncClient === null) {
      setSession(null);
      return undefined;
    }
    let live = true;
    void syncClient.auth.getSession().then(({ data, error }) => {
      if (live) setSession(error ? null : data.session);
    }, () => { if (live) setSession(null); });
    return () => {
      live = false;
    };
  }, [propSession, syncClient]);

  useEffect(() => {
    if (started.current) return;
    if (session === undefined) return;
    if (syncClient === null) {
      if (session === null) {
        started.current = true;
        if (callback.nonce !== null) takeOpenRouterVerifier(callback.nonce);
        setPhase("error");
      }
      return;
    }
    started.current = true;
    void (async () => {
      const { code, nonce } = callback;
      if (session === null) {
        if (nonce !== null) takeOpenRouterVerifier(nonce);
        setPhase("error");
        return;
      }
      const verifier = nonce === null ? null : takeOpenRouterVerifier(nonce);
      if (code === null || verifier === null) {
        setPhase("error");
        return;
      }
      const exchange = await exchangeOpenRouterCode(code, verifier);
      if (!exchange.ok) {
        setPhase("error");
        return;
      }
      const stored = await storeCloudKey(syncClient, {
        provider: "openrouter",
        label: "OpenRouter",
        key: exchange.key,
      });
      setPhase(stored.ok ? "success" : "error");
    })();
  }, [callback, session, syncClient]);

  useEffect(() => {
    if (phase !== "success") return;
    const timer = window.setTimeout(() => {
      window.location.assign(`/app?${CONFIGURATION_DEEP_LINK_PARAM}=1`);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <main id="main" className="ol-shell mx-auto w-full max-w-md px-4 py-8">
      <div className="mb-8 flex items-center gap-3">
        <BrandLockup markClassName="h-7 w-7 flex-none text-brand" wordClassName="ol-product-wordmark text-lg" />
      </div>
      {session === null ? (
        <Card title={t("authTitle")}>
          <p>{t("authBody")}</p>
          <Link href="/app?configuration=1">{t("openDashboard")}</Link>
        </Card>
      ) : phase === "exchanging" && <Card title={t("title")}>{t("body")}</Card>}
      {phase === "success" && <Card title={t("successTitle")}>{t("successBody")}</Card>}
      {phase === "error" && (
        <Card title={t("errorTitle")}>
          <p>{t("errorBody")}</p>
          <p>
            <Link
              href={`/app?${CONFIGURATION_DEEP_LINK_PARAM}=1`}
              className="focus-ring inline-flex rounded-lg border border-hairline-strong px-4 py-2 text-sm font-medium text-heading hover:border-heading"
            >
              {t("openDashboard")}
            </Link>
          </p>
        </Card>
      )}
    </main>
  );
}
