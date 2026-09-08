"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { BrandLockup } from "@/components/brand";
import { SignInCard } from "@/components/sign-in-card";
import {
  applyKeepSignedIn,
  createAccountClient,
  readKeepSignedIn,
  resumeAccountClient,
  stopAccountClient,
  writeKeepSignedIn,
} from "@/lib/account-client";
import { stripQueryParam } from "@/lib/browser-history";
import { clearIntent, pendingIntent, rememberIntent } from "@/lib/pending-intent";
import {
  callCliLogin,
  cleanCliCode,
  type CliLoginErrorCode,
  validateCliCode,
} from "@/lib/cli-login";

/**
 * The CLI approve page's real component, kept out of page.tsx on purpose.
 *
 * Next's generated route type check refuses a page module that exports
 * anything beyond the framework's own whitelist (default, metadata,
 * generateStaticParams, and the rest of `next.mjs`'s own config fields), and
 * it separately refuses a default export whose props are anything but
 * `params`/`searchParams`. A component built to be driven by props in a test,
 * this one included, satisfies neither rule, so it lives in its own file and
 * page.tsx renders it with nothing.
 */

const CARD = "rounded-2xl border border-hairline bg-surface p-5";
const BUTTON =
  "lift-sm focus-ring inline-flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium";
const BUTTON_PRIMARY = `${BUTTON} border-transparent bg-solid text-on-solid hover:bg-solid-hover disabled:cursor-not-allowed disabled:opacity-50`;
const BUTTON_GHOST = `${BUTTON} border-hairline-strong bg-transparent text-heading hover:border-heading disabled:cursor-not-allowed disabled:opacity-50`;

function Card({
  title,
  tone = "neutral",
  children,
}: {
  title: string;
  tone?: "neutral" | "accent";
  children: ReactNode;
}) {
  return (
    <section className={CARD} aria-live="polite">
      <h1 className="flex items-center gap-2 text-lg font-medium text-heading">
        <span
          aria-hidden="true"
          className={`h-2 w-2 flex-none rounded-full ${tone === "accent" ? "bg-accent-solid" : "bg-muted"}`}
        />
        {title}
      </h1>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  );
}

export interface CliPageProps {
  client?: SupabaseClient | null;
  session?: Session | null;
  initialCode?: string;
}

export function CliPageView({
  client: propClient,
  session: propSession,
  initialCode,
}: CliPageProps) {
  const t = useTranslations("hub");
  const [keepSignedIn, setKeepSignedIn] = useState(() => readKeepSignedIn());
  const syncClient = useMemo(
    () => (propClient !== undefined ? propClient : createAccountClient(keepSignedIn)),
    [propClient, keepSignedIn],
  );
  const [session, setSession] = useState<Session | null | undefined>(propSession);
  const authListener = useRef<{ unsubscribe: () => void } | null>(null);

  const [code, setCode] = useState<string>(() => {
    if (initialCode) return cleanCliCode(initialCode);
    if (typeof window !== "undefined") {
      const param = new URLSearchParams(window.location.search).get("code");
      if (param) return cleanCliCode(param);
    }
    return "";
  });

  const [deviceLabel, setDeviceLabel] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("device_label") ?? params.get("label") ?? params.get("device");
    }
    return null;
  });

  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [phase, setPhase] = useState<"idle" | "approved" | "denied">("idle");
  const [error, setError] = useState<CliLoginErrorCode | "unavailable" | null>(null);

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
    void syncClient.auth
      .getSession()
      .then(({ data }) => {
        if (live) setSession(data.session);
      })
      .catch(() => {
        if (live) setSession(null);
      });

    const { data } = syncClient.auth.onAuthStateChange((_event, nextSession) => {
      if (live) setSession(nextSession);
    });
    authListener.current = data.subscription;

    return () => {
      live = false;
      authListener.current?.unsubscribe();
      authListener.current = null;
    };
  }, [propSession, syncClient]);

  useEffect(() => {
    if (initialCode) {
      setCode(cleanCliCode(initialCode));
      return;
    }
    if (typeof window !== "undefined") {
      const param = new URLSearchParams(window.location.search).get("code");
      if (param) {
        setCode(cleanCliCode(param));
        if (validateCliCode(cleanCliCode(param)).valid && rememberIntent({ kind: "cli", code: cleanCliCode(param) })) {
          stripQueryParam("code");
        }
      } else {
        const pending = pendingIntent();
        if (pending?.kind === "cli") setCode(pending.code);
      }
    }
  }, [initialCode]);

  useEffect(() => {
    if (session && code) {
      if (pendingIntent()?.kind === "cli") clearIntent();
      stripQueryParam("code");
    }
  }, [session, code]);

  const changeKeepSignedIn = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (next === keepSignedIn) return true;
      await stopAccountClient(syncClient);
      authListener.current?.unsubscribe();
      authListener.current = null;
      if (!applyKeepSignedIn(next)) {
        await resumeAccountClient(syncClient);
        return false;
      }
      writeKeepSignedIn(next);
      setKeepSignedIn(next);
      return true;
    },
    [keepSignedIn, syncClient],
  );

  const handleCodeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const cleaned = cleanCliCode(event.target.value);
    setCode(cleaned);
    setError(null);
  };

  const validation = useMemo(() => validateCliCode(code), [code]);

  const validationMessage = useMemo(() => {
    if (code.length === 0) return null;
    if (validation.hasInvalidChars) {
      return t("cliPage.validationInvalidChars");
    }
    if (!validation.isRightLength) {
      return t("cliPage.validationLength");
    }
    return null;
  }, [code, validation, t]);

  const errorSentence = useMemo(() => {
    if (!error) return null;
    switch (error) {
      case "unknown_code":
        return t("cliPage.errorUnknownCode");
      case "expired":
        return t("cliPage.errorExpired");
      case "already_used":
        return t("cliPage.errorAlreadyUsed");
      case "device_cap":
        return t("cliPage.errorDeviceCap");
      case "unavailable":
      default:
        return t("cliPage.errorGeneric");
    }
  }, [error, t]);

  const submitAction = async (action: "approve" | "deny") => {
    if (!syncClient || !validation.valid || busy !== null) return;
    setBusy(action);
    setError(null);
    const outcome = await callCliLogin(syncClient, action, code);
    setBusy(null);

    if (outcome.deviceLabel) {
      setDeviceLabel(outcome.deviceLabel);
    }

    if (outcome.ok) {
      setPhase(action === "approve" ? "approved" : "denied");
    } else {
      setError(outcome.error ?? "unavailable");
    }
  };

  const onSubmitApprove = (event: FormEvent) => {
    event.preventDefault();
    void submitAction("approve");
  };

  const handleDeny = () => {
    void submitAction("deny");
  };

  if (session === null) {
    return (
      <main id="main" className="ol-shell mx-auto w-full max-w-md px-4 py-8">
        <div className="mb-8 flex items-center gap-3">
          <BrandLockup
            markClassName="h-7 w-7 flex-none text-brand"
            wordClassName="ol-product-wordmark text-lg"
          />
        </div>
        {syncClient === null ? (
          <section className="rounded-2xl border border-hairline bg-surface p-5" aria-label="Sign in">
            <h1 className="text-xl font-medium tracking-tight text-heading">Sign in to OpenLimiter</h1>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Account sign in is not configured in this deployment.
            </p>
          </section>
        ) : (
          <SignInCard
            client={syncClient}
            heading="h1"
            keepSignedIn={keepSignedIn}
            onKeepSignedInChange={changeKeepSignedIn}
          />
        )}
      </main>
    );
  }

  if (session === undefined) {
    return (
      <main id="main" className="ol-shell mx-auto w-full max-w-md px-4 py-8">
        <div className="mb-8 flex items-center gap-3">
          <BrandLockup
            markClassName="h-7 w-7 flex-none text-brand"
            wordClassName="ol-product-wordmark text-lg"
          />
        </div>
        <Card title={t("cliPage.loadingTitle")} tone="accent">
          <p>{t("cliPage.loadingBody")}</p>
        </Card>
      </main>
    );
  }

  if (phase === "approved") {
    return (
      <main id="main" className="ol-shell mx-auto w-full max-w-md px-4 py-8">
        <div className="mb-8 flex items-center gap-3">
          <BrandLockup
            markClassName="h-7 w-7 flex-none text-brand"
            wordClassName="ol-product-wordmark text-lg"
          />
        </div>
        <Card title={t("cliPage.successTitle")} tone="accent">
          <p>{t("cliPage.successBody")}</p>
          {deviceLabel && (
            <p className="font-medium text-heading">
              {t("cliPage.deviceLabel", { label: deviceLabel })}
            </p>
          )}
          <p>
            <Link href="/app" className={BUTTON_GHOST}>
              {t("cliPage.openDashboard")}
            </Link>
          </p>
        </Card>
      </main>
    );
  }

  if (phase === "denied") {
    return (
      <main id="main" className="ol-shell mx-auto w-full max-w-md px-4 py-8">
        <div className="mb-8 flex items-center gap-3">
          <BrandLockup
            markClassName="h-7 w-7 flex-none text-brand"
            wordClassName="ol-product-wordmark text-lg"
          />
        </div>
        <Card title={t("cliPage.deniedTitle")}>
          <p>{t("cliPage.deniedBody")}</p>
          <p>
            <Link href="/app" className={BUTTON_GHOST}>
              {t("cliPage.openDashboard")}
            </Link>
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main id="main" className="ol-shell mx-auto w-full max-w-md px-4 py-8">
      <div className="mb-8 flex items-center gap-3">
        <BrandLockup
          markClassName="h-7 w-7 flex-none text-brand"
          wordClassName="ol-product-wordmark text-lg"
        />
      </div>
      <Card title={t("cliPage.title")}>
        <p>{t("cliPage.lead")}</p>
        {deviceLabel && (
          <p className="rounded-xl border border-hairline bg-raised px-4 py-2 text-center text-sm font-medium text-heading">
            {t("cliPage.deviceLabel", { label: deviceLabel })}
          </p>
        )}
        {errorSentence && (
          <p role="alert" className="rounded-lg border border-hairline bg-raised p-3 text-sm text-heading">
            {errorSentence}
          </p>
        )}
        <form onSubmit={onSubmitApprove} className="space-y-4">
          <div>
            <label htmlFor="cli-user-code" className="sr-only">
              {t("cliPage.codeLabel")}
            </label>
            <input
              id="cli-user-code"
              type="text"
              value={code}
              onChange={handleCodeChange}
              placeholder={t("cliPage.codePlaceholder")}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck="false"
              disabled={busy !== null}
              className="focus-ring w-full rounded-xl border border-hairline bg-code px-4 py-3 text-center font-mono text-xl tracking-widest text-heading uppercase placeholder:text-muted disabled:opacity-50"
            />
            {validationMessage && (
              <p role="alert" className="mt-2 text-xs font-medium text-amber-500">
                {validationMessage}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2">
            <button
              type="submit"
              disabled={!validation.valid || busy !== null}
              className={BUTTON_PRIMARY}
            >
              {busy === "approve" ? t("cliPage.approving") : t("cliPage.approve")}
            </button>
            <button
              type="button"
              disabled={!validation.valid || busy !== null}
              onClick={handleDeny}
              className={BUTTON_GHOST}
            >
              {busy === "deny" ? t("cliPage.denying") : t("cliPage.deny")}
            </button>
          </div>
        </form>
      </Card>
    </main>
  );
}
