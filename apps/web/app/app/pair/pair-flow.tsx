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
  endPhoneSession,
  establishPhoneSession,
  readCurrentPhoneBars,
  readPhonePairMeta,
} from "@/lib/phone-session";
import { serialPoll } from "@/lib/serial-poll";
import { claimPairingCode, pollPairingClaim } from "@/lib/pro-device";
import { PROVIDER_CODES, parseQuotaText } from "../engine";
import { LiveMeter } from "../live-meter";
import { DollarRow, observationAgeMinutes } from "../pieces";
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
  now: string;
  freshLabel: string;
  staleStateLabel: string;
  unknownAgeLabel: string;
  ageLabel: (minutes: number) => string;
  stateAnnouncement: (state: string) => string;
}

/**
 * The account's meters, drawn by the same row elements the desktop and the
 * browser dashboard draw, so one reading cannot look like two different
 * readings on two screens.
 */
function PhoneBars({ body, stale, locale, heading, staleLabel, now, freshLabel, staleStateLabel, unknownAgeLabel, ageLabel, stateAnnouncement }: PhoneBarsProps) {
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
          <LiveMeter snapshots={snapshots} now={now} demo={false} />
        )}
        {money.length > 0 && (
          <div className="ol-device-money">
            {money.map((row) => (
              <MoneyRow key={`${row.provider}:${row.accountId}:${row.code}`} row={row} locale={locale} now={now} offline={stale} freshLabel={freshLabel} staleStateLabel={staleStateLabel} unknownAgeLabel={unknownAgeLabel} ageLabel={ageLabel} stateAnnouncement={stateAnnouncement} />
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

function MoneyRow({ row, locale, now, offline, freshLabel, staleStateLabel, unknownAgeLabel, ageLabel, stateAnnouncement }: { row: MeterRow; locale: string; now: string; offline: boolean; freshLabel: string; staleStateLabel: string; unknownAgeLabel: string; ageLabel: (minutes: number) => string; stateAnnouncement: (state: string) => string }) {
  const age = observationAgeMinutes(row.observedAt, now);
  const stale = offline || row.stale || age === null || age > 5;
  return (
    <DollarRow
      name={`${row.provider} ${row.code}`}
      amountText={formatAmount(row, locale) ?? "unknown"}
      stale={stale}
      freshLabel={freshLabel}
      staleLabel={staleStateLabel}
      observationLabel={age === null ? unknownAgeLabel : ageLabel(age)}
      stateAnnouncement={stateAnnouncement(stale ? staleStateLabel : freshLabel)}
    />
  );
}

/* --------------------------------------------------------- the paired page */

type PairedPhase = "reading" | "renewing" | "ready" | "offline" | "revoked";

interface PairedState {
  phase: PairedPhase;
  /** The body of the last good read, which an offline page keeps drawing. */
  bars: unknown;
  /** Bumped to re-run the read effect after a renewal, with no secret in it. */
  generation: number;
}

/**
 * The page after pairing: renew if the local marker says the token is due,
 * then read. Neither step ever touches a token or a refresh credential
 * directly; both are same-origin calls to the routes under
 * app/app/pair/api, which hold the only copies that exist.
 *
 * Renewal happens on every open rather than on a failed read, because the
 * server answers phone_renew even for an expired token and waiting for a
 * refusal would cost the reader a broken screen first. `requestPhoneRenewal`
 * itself is what serialises this across tabs (a Web Lock, reread after
 * acquiring it), so this effect does not have to know anything about other
 * tabs to be safe from the race that used to overwrite a newer pair.
 *
 * The one answer that ends the pairing is the server's explicit revoked
 * epoch signal, surfaced by a renewal or, defensively, by a read; a
 * `no_pair` answer from a fresh mount instead calls `onUnpaired`, because
 * the browser was never paired to begin with rather than having been kicked
 * off one.
 */
function PairedPhone({
  label,
  t,
  onUnpaired,
  initialBars,
}: {
  label: string;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
  onUnpaired: () => void;
  initialBars: unknown;
}) {
  const [state, setState] = useState<PairedState>({
    phase: initialBars === null ? "reading" : "ready",
    bars: initialBars,
    generation: 0,
  });
  const locale = useRef("en");
  const [now, setNow] = useState(() => new Date().toISOString());
  const retry = useRef<(() => Promise<void>) | null>(null);
  const unpairedRef = useRef(onUnpaired);
  unpairedRef.current = onUnpaired;

  useEffect(() => {
    locale.current = navigator.language || "en";
  }, []);

  useEffect(() => {
    let live = true;
    const poll = serialPoll(async () => {
      const answer = await readCurrentPhoneBars();
      if (!live) return;
      if (answer.kind === "revoked") {
        await endPhoneSession();
        setState((previous) => ({ ...previous, phase: "revoked" }));
        poll.stop();
        return;
      }
      if (answer.kind === "unpaired") {
        unpairedRef.current();
        poll.stop();
        return;
      }
      if (answer.kind === "fresh") {
        setState((previous) => ({ ...previous, bars: answer.body, phase: "ready", generation: previous.generation + 1 }));
        return;
      }
      setState((previous) => ({ ...previous, phase: "offline" }));
    }, 60_000);
    retry.current = poll.refresh;
    const refreshClock = () => {
      if (document.visibilityState !== "hidden") setNow(new Date().toISOString());
    };
    const onVisibilityChange = () => refreshClock();
    const clock = window.setInterval(refreshClock, 10_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      live = false;
      poll.stop();
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      retry.current = null;
    };
  }, []);

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
        <button className={BUTTON_GHOST} onClick={() => { void retry.current?.(); }}>{t("pairPage.retry")}</button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-center text-xs text-muted">{t("pairPage.pairedAs", { label })}</p>
      <PhoneBars
        body={state.bars}
        stale={state.phase === "offline"}
        locale={locale.current}
        heading={t("pairPage.bars.title")}
        staleLabel={t("pairPage.offline.staleMark")}
        now={now}
        freshLabel={t("cloud.fresh")}
        staleStateLabel={t("cloud.stale")}
        unknownAgeLabel={t("cloud.observationUnknown")}
        ageLabel={(minutes) => t("cloud.observationAge", { minutes })}
        stateAnnouncement={(state) => t("cloud.stateAnnouncement", { state })}
      />
      <button className={BUTTON_GHOST} onClick={() => { void retry.current?.(); }}>{t("pairPage.retry")}</button>
      <PairInstallStep />
    </div>
  );
}

/* ----------------------------------------------------------- the flow */

/**
 * The very first state this page is in, computed before the first paint.
 *
 * `useState`'s lazy initializer runs synchronously during render, ahead of
 * anything reaching the screen, which is what "render nothing until the
 * fragment is read and replaced" actually requires: an effect runs after the
 * first commit, which is one paint too late for a code sitting in the address
 * bar. The fragment is stripped here whether it held a valid code, an invalid
 * one, or nothing at all, so a stray `#code=` that failed to parse never
 * lingers in the history entry either.
 */
function initialFragmentState(): PairState {
  const empty: PairState = {
    phase: "reading",
    code: null,
    claimId: null,
    expiresAt: null,
    pollInterval: PAIRING_POLL_MILLISECONDS,
    session: null,
    phonePair: null,
  };
  if (typeof window === "undefined") return empty;
  const next = initialPairState(window.location.hash);
  if (window.location.hash !== "") {
    window.history.replaceState(null, "", window.location.pathname);
  }
  return next;
}

export function PairFlow() {
  const t = useTranslations("hub");
  const defaultLabel = t("pairPage.defaultLabel");
  const [state, setState] = useState<PairState>(initialFragmentState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [remaining, setRemaining] = useState<number | null>(null);
  /* Non-null means: show the paired screen under this label. Set either by a
     fresh approval or by finding a still valid pairing on a returning visit;
     never carries a token or a refresh credential, both of which live only
     as HttpOnly cookies from the moment either path succeeds. */
  const [pairedLabel, setPairedLabel] = useState<string | null>(null);
  const [pairedBars, setPairedBars] = useState<unknown>(null);
  const [checkingExisting, setCheckingExisting] = useState(() => state.phase !== "claiming");
  const claimStarted = useRef(false);

  /*
   * The claim itself, for a freshly scanned code only.
   *
   * The fragment was already read and stripped by the initializer above; this
   * effect only makes the network call, guarded so React's development mode
   * double invocation cannot claim the same code twice.
   */
  useEffect(() => {
    if (state.phase !== "claiming" || state.code === null) return;
    if (claimStarted.current) return;
    claimStarted.current = true;
    const code = state.code;
    let live = true;
    void (async () => {
      const meta = browserMeta();
      const device = pairDeviceMeta(meta);
      const hash = await pairUserAgentHash(navigator.userAgent);
      const response = await claimPairingCode(code, {
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
  }, [state.phase, state.code]);

  /*
   * A returning visit, with no code in the fragment at all.
   *
   * The only honest way to know whether this browser is still paired is to
   * ask: the secrets that would prove it live in cookies this component
   * cannot read. The local marker is used only for its label and to decide
   * whether an unreadable answer is worth showing as "offline" rather than
   * "scan again": a marker from a previous pairing means this browser was
   * paired before, so a transient failure reads as offline; no marker and no
   * successful read means there is nothing to offer but a fresh scan.
   */
  useEffect(() => {
    if (state.phase === "claiming") return;
    let live = true;
    void (async () => {
      const meta = readPhonePairMeta();
      if (meta !== null) {
        setPairedLabel(meta.label);
        setCheckingExisting(false);
        return;
      }
      const answer = await readCurrentPhoneBars();
      if (!live) return;
      if (answer.kind === "fresh") {
        setPairedBars(answer.body);
        setPairedLabel(defaultLabel);
        setCheckingExisting(false);
        return;
      }
      setCheckingExisting(false);
    })();
    return () => {
      live = false;
    };
  }, [state.phase, defaultLabel]);

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
    const poll = serialPoll(async () => {
      if (!live) return;
      if (!pairShouldPoll(stateRef.current)) {
        setState(pairStateAfterTimeout);
        return;
      }
      const response = await pollPairingClaim(claimId);
      if (live) setState((current) => pairStateAfterPoll(current, response.body, response.status));
    }, state.pollInterval);
    return () => {
      live = false;
      poll.stop();
    };
  }, [state.phase, state.claimId, state.pollInterval, state.expiresAt]);

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
   * The new delivery carries the read token and the refresh credential.
   * Neither is ever stored by this component: they are handed once to the
   * session route, which is the only thing that turns them into cookies, and
   * the phone stays on this page under the label that route confirmed. The
   * legacy delivery, a device session alone, keeps the old behaviour exactly:
   * stored, then handed over to /app.
   */
  const establishing = useRef(false);
  useEffect(() => {
    if (state.phase !== "approved") return;
    if (state.phonePair !== null) {
      if (establishing.current) return;
      establishing.current = true;
      const pair = state.phonePair;
      const label = pairDeviceMeta(browserMeta()).name;
      void establishPhoneSession(pair, label).then((ok) => {
        if (ok) setPairedLabel(label);
        /* A failed establish leaves nothing usable behind; the reader's only
           path forward is to scan again, and no secret was ever kept here to
           clean up. */
      });
      return;
    }
    if (state.session === null) return;
    writeDeviceSession(state.session);
    window.location.assign("/app");
  }, [state.phase, state.session, state.phonePair]);

  if (pairedLabel !== null) {
    return (
      <PairedPhone
        label={pairedLabel}
        t={t}
        initialBars={pairedBars}
        onUnpaired={() => {
          setPairedLabel(null);
          setPairedBars(null);
        }}
      />
    );
  }

  if (checkingExisting || state.phase === "reading" || state.phase === "claiming") {
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
