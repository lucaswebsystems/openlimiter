"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { writeDeviceSession } from "@/lib/device-session";
import {
  amountRows,
  formatAmount,
  meterRowsOf,
  snapshotFromMeterRow,
  type MeterRow,
} from "@/lib/device-snapshots";
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
import {
  clearPhonePair,
  phonePairNeedsRenewal,
  readPhoneBars,
  readPhonePair,
  renewPhonePair,
  writePhonePair,
  type PhonePair,
} from "@/lib/phone-session";
import { claimPairingCode, pollPairingClaim } from "@/lib/pro-device";
import { PROVIDER_CODES, parseQuotaText } from "../engine";
import { LiveMeter } from "../live-meter";
import { PairInstallStep } from "./pair-install";

/**
 * The pairing flow, at 375 wide first, and the phone's own dashboard after.
 *
 * A phone reaches this page from a QR code. The code is lifted out of the
 * address bar before anything else renders: it never reached a server through
 * the URL, and after that first read it is not in the history entry either,
 * so a shared screenshot of the address bar carries nothing. The install step
 * is mounted only after that, because iOS drops the fragment when an
 * installed copy is launched from its icon, and the code must already be out
 * of the address bar by then.
 *
 * Approval hands the page a read token and a refresh credential, stored
 * together under one key. Every later open renews through phone_renew when
 * the token is within an hour of its end or past it, and the bars render here
 * through the same read path the paired device view uses. A revoked epoch is
 * the one answer that ends the pairing; every other failure keeps the last
 * good bars on screen with the stale mark.
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

/* -------------------------------------------------------------- the bars */

/** Percentage rows are drawn by the engine, so only these providers qualify. */
const ENGINE_PROVIDERS: readonly string[] = PROVIDER_CODES;

interface PhoneBarsProps {
  body: unknown;
  /** True when these are the last good readings and the service did not answer. */
  stale: boolean;
  locale: string;
  heading: string;
  staleLabel: string;
}

/**
 * The account's meters, drawn by the same row elements the desktop and the
 * browser dashboard draw, so one reading cannot look like two different
 * readings on two screens.
 */
function PhoneBars({ body, stale, locale, heading, staleLabel }: PhoneBarsProps) {
  const rows = useMemo(() => meterRowsOf(body), [body]);
  const snapshots = useMemo(() => {
    const raw = rows.map(snapshotFromMeterRow).filter((row) => row !== null);
    const parsed = parseQuotaText(JSON.stringify(raw), new Date().toISOString());
    return parsed.ok ? parsed.snapshots : [];
  }, [rows]);
  const money = useMemo(() => amountRows(rows, ENGINE_PROVIDERS), [rows]);

  return (
    <section className={CARD} data-stale={stale ? "" : undefined}>
      <h1 className="flex items-center gap-2 text-lg font-medium text-heading">
        <span
          aria-hidden="true"
          className={`h-2 w-2 flex-none rounded-full ${stale ? "bg-muted" : "bg-accent-solid"}`}
        />
        {heading}
        {stale && (
          <span
            data-stale-mark=""
            className="rounded-full border border-hairline bg-raised px-2 py-0.5 text-xs font-medium text-muted"
          >
            {staleLabel}
          </span>
        )}
      </h1>
      <div className="mt-3 space-y-3">
        {snapshots.length > 0 && (
          <LiveMeter snapshots={snapshots} now={new Date().toISOString()} demo={false} />
        )}
        {money.length > 0 && (
          <div className="ol-device-money">
            {money.map((row) => (
              <MoneyRow key={`${row.provider}:${row.accountId}:${row.code}`} row={row} locale={locale} />
            ))}
          </div>
        )}
        {snapshots.length === 0 && money.length === 0 && (
          <p className="text-sm leading-relaxed text-muted">{heading}</p>
        )}
      </div>
    </section>
  );
}

function MoneyRow({ row, locale }: { row: MeterRow; locale: string }) {
  const amount = formatAmount(row, locale);
  return (
    <div className="ol-device-money-row">
      <span className="ol-device-money-name">
        {row.provider} {row.code}
      </span>
      <span className="ol-device-money-value" data-state={row.stale ? "stale" : "fresh"}>
        {amount ?? "unknown"}
      </span>
    </div>
  );
}

/* --------------------------------------------------------- the paired page */

type PairedPhase = "reading" | "renewing" | "ready" | "offline" | "revoked";

interface PairedState {
  phase: PairedPhase;
  pair: PhonePair;
  /** The body of the last good read, which an offline page keeps drawing. */
  bars: unknown;
}

/**
 * The page after pairing: renew if the token is due, then read.
 *
 * Renewal happens on every open rather than on a failed read, because the
 * server answers phone_renew even for an expired token and waiting for a
 * refusal would cost the reader a broken screen first. The effect is driven
 * by the pair itself: a renewal that answers writes the fresh pair, the pair
 * changing re runs the effect, and the run that follows is the read.
 */
function PairedPhone({ pair, t }: { pair: PhonePair; t: (key: string) => string }) {
  const [state, setState] = useState<PairedState>({
    phase: "reading",
    pair,
    bars: null,
  });
  const locale = useRef("en");

  useEffect(() => {
    locale.current = navigator.language || "en";
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const current = state.pair;
      /* Renew first when the token is within the renewal window. */
      if (phonePairNeedsRenewal(current)) {
        setState((previous) => ({ ...previous, phase: "renewing" }));
        const outcome = await renewPhonePair(current);
        if (!live) return;
        if (outcome.kind === "revoked") {
          clearPhonePair();
          setState((previous) => ({ ...previous, phase: "revoked" }));
          return;
        }
        if (outcome.kind === "renewed") {
          writePhonePair(outcome.pair);
          /* The fresh pair replaces the stale one, which re runs this effect:
             the renewed token is what the read below then carries. */
          setState((previous) => ({ ...previous, pair: outcome.pair, phase: "reading" }));
          return;
        }
        /* Unavailable: keep the pair. It may still read. */
      }
      const answer = await readPhoneBars(current);
      if (!live) return;
      if (answer.kind === "revoked") {
        clearPhonePair();
        setState((previous) => ({ ...previous, phase: "revoked" }));
        return;
      }
      if (answer.kind === "fresh") {
        setState((previous) => ({ ...previous, bars: answer.body, phase: "ready" }));
        return;
      }
      setState((previous) => ({ ...previous, phase: "offline" }));
    })();
    return () => {
      live = false;
    };
  }, [state.pair]);

  if (state.phase === "revoked") {
    return (
      <Card title={t("pairPage.revoked.title")}>
        <p>{t("pairPage.revoked.body")}</p>
        <p>
          <Link href="/app" className={BUTTON_GHOST}>
            {t("pairPage.openDashboard")}
          </Link>
        </p>
      </Card>
    );
  }

  if (state.phase === "renewing" && state.bars === null) {
    return (
      <Card title={t("pairPage.renewing.title")} tone="accent">
        <p>{t("pairPage.renewing.body")}</p>
      </Card>
    );
  }

  if (state.phase === "reading" && state.bars === null) {
    return (
      <Card title={t("pairPage.reading.title")} tone="accent">
        <p>{t("pairPage.reading.body")}</p>
      </Card>
    );
  }

  if (state.phase === "offline" && state.bars === null) {
    return (
      <Card title={t("pairPage.offline.title")}>
        <p>{t("pairPage.offline.body")}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <PhoneBars
        body={state.bars}
        stale={state.phase === "offline"}
        locale={locale.current}
        heading={t("pairPage.bars.title")}
        staleLabel={t("pairPage.offline.staleMark")}
      />
      <PairInstallStep />
    </div>
  );
}

/* ----------------------------------------------------------- the flow */

export function PairFlow() {
  const t = useTranslations("hub");
  const [state, setState] = useState<PairState>({
    phase: "reading",
    code: null,
    claimId: null,
    expiresAt: null,
    pollInterval: PAIRING_POLL_MILLISECONDS,
    session: null,
    phonePair: null,
  });
  const [remaining, setRemaining] = useState<number | null>(null);
  const [stored, setStored] = useState<PhonePair | null>(null);
  const claimed = useRef(false);

  /*
   * The fragment is read and consumed before anything else on the page.
   *
   * A returning phone carries no code: the credential pair it stored on its
   * first visit is its way in, and iOS would have dropped the fragment of an
   * installed launch anyway. A fresh scan carries the code, which is claimed
   * at once and stripped from the history entry.
   */
  useEffect(() => {
    if (claimed.current) return;
    claimed.current = true;
    const next = initialPairState(window.location.hash);
    if (next.phase !== "claiming" || next.code === null) {
      const existing = readPhonePair();
      if (existing !== null) {
        setStored(existing);
        setState({ ...next, phase: "approved", phonePair: existing });
        return;
      }
      setState(next);
      return;
    }
    setState(next);
    window.history.replaceState(null, "", window.location.pathname);
    let live = true;
    void (async () => {
      const meta = browserMeta();
      const device = pairDeviceMeta(meta);
      const hash = await pairUserAgentHash(navigator.userAgent);
      const response = await claimPairingCode(next.code as string, {
        ...device,
        user_agent_hash: hash,
      });
      if (live) {
        setState((current) => pairStateAfterClaim(current, response.body, response.status));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /*
    Ask the server whether the desktop has answered, until it has or time is up.

    The interval comes off the state rather than from a constant, so a refused
    poll actually slows the next one down: `pairStateAfterPoll` answers a 429
    with a new state carrying twice the gap, this effect sees a state it has not
    seen before, and the timer is rebuilt at the new rate. A poll that is merely
    waiting returns the same object, so the steady state rebuilds nothing.
  */
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
    }, state.pollInterval);
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

  /*
   * Approval, as a fork.
   *
   * The new delivery carries the read token and the refresh credential: they
   * are stored under one key and the phone stays on this page, which renders
   * its bars here. The legacy delivery, a device session alone, keeps the old
   * behaviour exactly: stored, then handed over to /app.
   */
  useEffect(() => {
    if (state.phase !== "approved") return;
    if (state.phonePair !== null) {
      writePhonePair(state.phonePair);
      setStored(state.phonePair);
      return;
    }
    if (state.session === null) return;
    writeDeviceSession(state.session);
    window.location.assign("/app");
  }, [state.phase, state.session, state.phonePair]);

  const paired = state.phase === "approved" ? (state.phonePair ?? stored) : null;

  if (paired !== null) {
    return <PairedPhone pair={paired} t={t} />;
  }

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
