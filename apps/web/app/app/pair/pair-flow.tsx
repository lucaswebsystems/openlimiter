"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { writeDeviceSession } from "@/lib/device-session";
import {
  initialPairState,
  pairDeviceMeta,
  PAIRING_POLL_MILLISECONDS,
  PAIRING_TTL_SECONDS,
  pairShouldPoll,
  pairStateAfterClaim,
  pairStateAfterPoll,
  pairStateAfterTimeout,
  pairUserAgentHash,
  type PairState,
} from "@/lib/pairing";
import { claimPairingCode, pollPairingClaim } from "@/lib/pro-device";

/**
 * The pairing flow, at 375 wide first.
 *
 * A phone reaches this page from a QR code and does exactly one thing on it:
 * waits. So the page is one column, one card, one instruction and one state at
 * a time, and every state is drawn rather than printed as a bare line.
 *
 * The code is lifted out of the address bar as soon as it has been read. It
 * never reached a server through the URL, and after this it is not in the
 * history entry either, so a shared screenshot of the address bar carries
 * nothing. It stays on screen as text, where it belongs: the desktop shows the
 * same eight characters and a person compares them.
 */

interface BrowserMeta {
  platform: string;
  brand: string;
  mobile: boolean;
}

interface UserAgentData {
  platform?: string;
  mobile?: boolean;
  brands?: { brand: string }[];
}

function browserMeta(): BrowserMeta {
  const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
  const brands = data?.brands ?? [];
  const brand =
    brands.map((entry) => entry.brand).find((name) => !/not.?a.?brand/iu.test(name)) ?? "";
  return {
    platform: data?.platform ?? navigator.platform ?? "",
    brand,
    mobile: data?.mobile ?? /Mobi|Android|iPhone|iPad/u.test(navigator.userAgent),
  };
}

const CARD = "rounded-2xl border border-hairline bg-surface p-5";
const BUTTON =
  "lift-sm focus-ring inline-flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium";
const BUTTON_PRIMARY = `${BUTTON} border-transparent bg-solid text-on-solid hover:bg-solid-hover`;
const BUTTON_GHOST = `${BUTTON} border-hairline-strong bg-transparent text-heading hover:border-heading`;

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

function CodeReadout({ code }: { code: string }) {
  return (
    <p className="rounded-xl border border-hairline bg-code px-4 py-3 text-center font-mono text-xl tracking-widest text-heading">
      <span className="sr-only">Pairing code </span>
      {code}
    </p>
  );
}

export function PairFlow() {
  const [state, setState] = useState<PairState>({
    phase: "reading",
    code: null,
    claimId: null,
    expiresAt: null,
    session: null,
  });
  const [remaining, setRemaining] = useState<number | null>(null);
  const claimed = useRef(false);

  /* Read the fragment, take the code out of the address bar, and claim it. */
  useEffect(() => {
    if (claimed.current) return;
    claimed.current = true;
    const next = initialPairState(window.location.hash);
    setState(next);
    const code = next.code;
    if (next.phase !== "claiming" || code === null) return;
    window.history.replaceState(null, "", window.location.pathname);
    let live = true;
    void (async () => {
      const meta = browserMeta();
      const device = pairDeviceMeta(meta);
      const hash = await pairUserAgentHash(navigator.userAgent);
      const response = await claimPairingCode(code, { ...device, user_agent_hash: hash });
      if (live) {
        setState((current) => pairStateAfterClaim(current, response.body, response.status));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /* Ask the server whether the desktop has answered, until it has or time is up. */
  useEffect(() => {
    if (state.phase !== "waiting" || state.claimId === null) return;
    const claimId = state.claimId;
    let live = true;
    const timer = window.setInterval(() => {
      if (!pairShouldPoll(state)) {
        setState(pairStateAfterTimeout);
        return;
      }
      void pollPairingClaim(claimId).then((response) => {
        if (live) {
          setState((current) => pairStateAfterPoll(current, response.body, response.status));
        }
      });
    }, PAIRING_POLL_MILLISECONDS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [state]);

  /* The countdown under the code, so waiting has a visible end. */
  useEffect(() => {
    if (state.phase !== "waiting") {
      setRemaining(null);
      return;
    }
    const expires = state.expiresAt;
    const tick = () => {
      setRemaining(
        expires === null
          ? PAIRING_TTL_SECONDS
          : Math.max(0, Math.ceil(expires - Date.now() / 1_000)),
      );
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [state.phase, state.expiresAt]);

  /* Approval is the end of this page: store the session and hand over to /app. */
  useEffect(() => {
    if (state.phase !== "approved" || state.session === null) return;
    writeDeviceSession(state.session);
    window.location.assign("/app");
  }, [state.phase, state.session]);

  if (state.phase === "reading" || state.phase === "claiming") {
    return (
      <Card title="Reading the code" tone="accent">
        <p>One moment. Nothing has been sent anywhere yet.</p>
      </Card>
    );
  }

  if (state.phase === "noCode") {
    return (
      <Card title="This link has no pairing code">
        <p>
          A pairing code is generated by the desktop application and lives for two minutes. Open
          OpenLimiter on your computer, go to Devices, choose Pair a phone, and scan the code it
          shows.
        </p>
        <p>
          <Link href="/app" className={BUTTON_GHOST}>
            Open the dashboard
          </Link>
        </p>
      </Card>
    );
  }

  if (state.phase === "waiting") {
    return (
      <div className="space-y-4">
        <Card title="Waiting for approval" tone="accent">
          <p>
            Your computer is asking whether to trust this phone. Approve it there and this page
            moves on by itself.
          </p>
          {state.code !== null && <CodeReadout code={state.code} />}
          <p>
            Check that the desktop shows the same eight characters.
            {remaining !== null && remaining > 0 ? ` This code expires in ${remaining} seconds.` : ""}
          </p>
        </Card>
        <p className="text-center text-xs text-muted">
          The phone gets read only access. It can never change your account or upload anything.
        </p>
      </div>
    );
  }

  if (state.phase === "denied") {
    return (
      <Card title="The desktop said no">
        <p>
          Pairing was declined on your computer, so this phone was given nothing. If that was not
          you, start again from the desktop and check the code before approving.
        </p>
        <p>
          <Link href="/app" className={BUTTON_GHOST}>
            Open the dashboard
          </Link>
        </p>
      </Card>
    );
  }

  if (state.phase === "expired") {
    return (
      <Card title="That code has expired">
        <p>
          A pairing code lives for two minutes and can be used once. Generate a new one on the
          desktop and scan it again.
        </p>
        <p>
          <Link href="/app" className={BUTTON_GHOST}>
            Open the dashboard
          </Link>
        </p>
      </Card>
    );
  }

  if (state.phase === "approved") {
    return (
      <Card title="Paired" tone="accent">
        <p>This phone is paired. Opening your quota now.</p>
        <p>
          <Link href="/app" className={BUTTON_PRIMARY}>
            Continue
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card title="Pairing could not be completed">
      <p>
        The service did not answer, so nothing was paired and nothing was changed. Generate a fresh
        code on the desktop and scan it again.
      </p>
      <p>
        <Link href="/app" className={BUTTON_GHOST}>
          Open the dashboard
        </Link>
      </p>
    </Card>
  );
}
