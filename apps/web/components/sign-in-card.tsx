"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { authRedirectUrl } from "@/lib/pro";
import {
  OAUTH_PROVIDERS,
  PROVIDER_SCOPES,
  emailSwitchedOff,
  probeAuthorize,
  providerName,
  providerOffKey,
  startOAuth,
  type OAuthProvider,
  type SignInState,
} from "@/lib/sign-in";
import { BrandLockup } from "./brand";
import { SiteLink } from "./site-link";
import {
  Button,
  FIELD,
  GitHubMark,
  GoogleMark,
  MicrosoftMark,
  SectionPanel,
  Switch,
} from "./ui";

/** Each provider's own mark, drawn at 20 pixels, never recoloured. */
const PROVIDER_MARKS: Record<OAuthProvider, (props: { className?: string }) => ReactNode> = {
  github: GitHubMark,
  google: GoogleMark,
  azure: MicrosoftMark,
};

/** The message key holding each provider's button label. */
const PROVIDER_LABEL_KEYS: Record<OAuthProvider, string> = {
  github: "github",
  google: "google",
  azure: "microsoft",
};

/**
 * The sign in, drawn once.
 *
 * The dashboard gate at /app and the Pro portal both render this and nothing
 * else, so the two cannot drift apart. It is the one composition the desktop
 * sheet and the desktop first run step draw as well: a centred head with the
 * lockup, the title and one lead sentence, the two provider buttons with
 * their marks leading, a rule reading "or", and the email link kept behind a
 * link until somebody wants it. Only the title's size changes from host to
 * host. Every state the card can be in has a shape: opening a provider, a
 * link on its way, a link sent, a provider the service has switched off, and
 * a plain failure.
 *
 * THE SWITCH IS NOT THE CARD'S TO KEEP
 * ------------------------------------
 * "Keep me signed in" decides which store the session lands in, and that is
 * fixed when the auth client is constructed rather than when a button is
 * pressed. So the card draws the switch and reports the answer, and the host
 * holds it and rebuilds its client around it. A card that kept the state
 * itself would be a control that looks like it works and changes nothing.
 *
 * The host answers whether the move happened, and a no is drawn rather than
 * swallowed: a browser that refuses the write leaves the switch where it was
 * and says so, because a control that snaps back with no explanation is worse
 * than one that does not move.
 *
 * It is also locked while a sign in is in flight. Starting a provider sign in
 * writes a code verifier into whichever store the client was built around, and
 * the exchange after the redirect looks for it in that same store. Moving the
 * store in between strands the verifier and the sign in fails on return with
 * nothing on screen to explain it, so the switch is unavailable from the first
 * press until the browser has left, and stays unavailable once a link is on
 * its way to an address.
 *
 * The card never asks for a password. The web signs in with a provider or
 * with a single use link, and the privacy page says so.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It carries no "not now" button, because on the web there is nothing behind
 * the gate to go to without an account: the readings a browser can show are
 * the ones a person's own devices synced. What it carries instead is the
 * honest sentence, that the desktop application needs no account at all, and
 * the way to it. A page that renders it keeps its chrome quiet, see
 * PageShell's quietChrome, so nothing lands on these controls at the phone
 * width.
 */
export function SignInCard({
  client,
  heading = "h1",
  keepSignedIn,
  onKeepSignedInChange,
}: {
  client: SupabaseClient;
  /** The dashboard has no other heading, the portal already carries one. */
  heading?: "h1" | "h2";
  /** On by default. The host owns it because the host builds the client. */
  keepSignedIn: boolean;
  /** Answers whether the move happened. A false leaves the switch where it was. */
  onKeepSignedInChange: (next: boolean) => Promise<boolean>;
}) {
  const t = useTranslations("signIn");
  const formId = useId();
  const emailField = useRef<HTMLInputElement>(null);
  const emailForm = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<SignInState>({ kind: "idle" });
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);
  const busy = state.kind === "working";
  /* A verifier is in play from the first press until the browser has gone, and
     from a sent link until it is opened. The switch may not move under it. */
  const authInFlight = busy || state.kind === "sent";
  const Heading = heading;

  /* The field takes focus when it appears, and only then: a field that grabs
     focus on mount would steal it from the provider buttons above it. The
     whole form is then brought into view, so the control that sends the link
     is never left under the fold while the field it belongs to has focus. */
  useEffect(() => {
    if (!emailOpen) return;
    emailField.current?.focus({ preventScroll: true });
    emailForm.current?.scrollIntoView({ block: "nearest" });
  }, [emailOpen]);

  async function continueWith(provider: OAuthProvider) {
    setState({ kind: "working", via: provider });
    const outcome = await startOAuth(provider, {
      authorizeUrl: async () => {
        const { data, error } = await client.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: authRedirectUrl(),
            skipBrowserRedirect: true,
            scopes: PROVIDER_SCOPES[provider],
          },
        });
        return error === null ? data.url : null;
      },
      probe: probeAuthorize,
      navigate: (url) => window.location.assign(url),
    });
    /* On success the page is leaving, and the working state stays until it
       has gone. Only a refusal has something further to say. */
    if (!outcome.ok) setState({ kind: "error", reason: outcome.reason, provider });
  }

  async function sendLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (address === "") return;
    setState({ kind: "working", via: "email" });
    const { error } = await client.auth.signInWithOtp({
      email: address,
      options: { emailRedirectTo: authRedirectUrl() },
    });
    if (error === null) {
      setState({ kind: "sent", email: address });
      return;
    }
    setState({ kind: "error", reason: emailSwitchedOff(error.message) ? "emailOff" : "failed" });
  }

  return (
    <SectionPanel className="mx-auto w-full max-w-md scroll-mb-8">
      <div className="grid justify-items-center gap-3 text-center">
        <BrandLockup markClassName="h-7 w-7 flex-none text-brand" />
        <Heading className="text-xl font-medium tracking-tight text-heading">{t("title")}</Heading>
        <p className="max-w-xs text-sm leading-relaxed text-muted">{t("lead")}</p>
      </div>

      <div className="mt-6 grid gap-2">
        {OAUTH_PROVIDERS.map((provider) => {
          const Mark = PROVIDER_MARKS[provider];
          return (
            <Button
              key={provider}
              tone={provider === "github" ? "primary" : "ghost"}
              className="min-h-control-touch w-full"
              disabled={busy}
              onClick={() => void continueWith(provider)}
            >
              <Mark className="h-5 w-5" />
              {t(PROVIDER_LABEL_KEYS[provider])}
            </Button>
          );
        })}
      </div>

      <Switch
        className="mt-3"
        checked={keepSignedIn}
        disabled={authInFlight || switching}
        onChange={(next) => {
          setSwitchFailed(false);
          setSwitching(true);
          void onKeepSignedInChange(next).then(
            (moved) => {
              setSwitching(false);
              setSwitchFailed(!moved);
            },
            () => {
              setSwitching(false);
              setSwitchFailed(true);
            },
          );
        }}
        label={t("keepSignedIn")}
      />
      {switchFailed && (
        <p
          role="status"
          aria-live="polite"
          className="mt-1 rounded-lg border border-transparent bg-band-red-subtle px-3 py-2 text-sm leading-relaxed text-band-red-label"
        >
          {t("keepSignedInFailed")}
        </p>
      )}

      <div
        aria-hidden="true"
        className="my-4 flex items-center gap-3 text-2xs font-medium uppercase tracking-wider text-muted"
      >
        <span className="h-px flex-1 bg-hairline" />
        {t("or")}
        <span className="h-px flex-1 bg-hairline" />
      </div>

      {emailOpen ? (
        <form ref={emailForm} id={formId} onSubmit={sendLink} className="grid scroll-mb-8 gap-2">
          <label htmlFor={`${formId}-email`} className="text-sm font-medium text-heading">
            {t("emailLabel")}
          </label>
          <input
            ref={emailField}
            id={`${formId}-email`}
            type="email"
            required
            autoComplete="email"
            disabled={busy}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t("emailPlaceholder")}
            className={`${FIELD} min-h-control-touch`}
          />
          <Button type="submit" tone="ghost" className="min-h-control-touch w-full" disabled={busy}>
            {t("send")}
          </Button>
        </form>
      ) : (
        <div className="flex justify-center">
          <Button
            tone="quiet"
            className="min-h-control-touch underline decoration-hairline-strong underline-offset-4 hover:decoration-heading"
            aria-expanded={false}
            aria-controls={formId}
            onClick={() => setEmailOpen(true)}
          >
            {t("useEmail")}
          </Button>
        </div>
      )}

      <StatusLine state={state} />

      <p className="mt-5 text-center text-xs leading-relaxed text-muted">
        {t("noAccount")}{" "}
        <SiteLink
          href="/download"
          className="focus-ring rounded-sm font-medium text-heading underline decoration-hairline-strong underline-offset-4 hover:decoration-heading"
        >
          {t("getDesktop")}
        </SiteLink>
      </p>
    </SectionPanel>
  );
}

/**
 * The one line that says what is happening.
 *
 * A live region, present from the first render so a screen reader is already
 * listening when the first sentence lands, and drawn as a tinted row rather
 * than a bare sentence: neutral while working, the accent for a link that
 * went out, red for a refusal.
 */
function StatusLine({ state }: { state: SignInState }) {
  const t = useTranslations("signIn");
  if (state.kind === "idle") {
    return <p role="status" aria-live="polite" className="sr-only" />;
  }

  const tone = state.kind === "working" ? "working" : state.kind === "sent" ? "sent" : "error";
  const text =
    state.kind === "working"
      ? state.via === "email"
        ? t("sending")
        : t("opening", { provider: providerName(state.via) })
      : state.kind === "sent"
        ? t("sent", { email: state.email })
        : state.reason === "providerOff"
          ? t(providerOffKey(state.provider))
          : state.reason === "emailOff"
            ? t("emailOff")
            : t("failed");
  const tint =
    tone === "working"
      ? "border-hairline bg-raised text-soft"
      : tone === "sent"
        ? "border-transparent bg-accent-subtle text-accent"
        : "border-transparent bg-band-red-subtle text-band-red-label";

  return (
    <p
      role="status"
      aria-live="polite"
      className={`mt-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm leading-relaxed ${tint}`}
    >
      {tone === "working" ? (
        <span
          aria-hidden="true"
          className="mt-0.5 h-4 w-4 flex-none animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
        />
      ) : (
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full border border-current text-2xs font-semibold leading-none"
        >
          {tone === "sent" ? "✓" : "!"}
        </span>
      )}
      <span>{text}</span>
    </p>
  );
}
