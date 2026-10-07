"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  amountRows,
  DEVICE_FRESH_MILLISECONDS,
  formatAmount,
  meterRowsOf,
  snapshotFromMeterRow,
  type MeterRow,
} from "@/lib/device-snapshots";
import {
  initialPairState,
  pairCodeFromFragment,
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
  establishPhoneSession,
  readCurrentPhoneBars,
  readPhoneLastBars,
  readPhonePairMeta,
  phonePairOf,
} from "@/lib/phone-session";
import { createPhoneSessionRuntime } from "@/lib/session-runtime";
import { serialPoll } from "@/lib/serial-poll";
import { claimPairingCode, pollPairingClaim } from "@/lib/pro-device";
import { PROVIDER_CODES, buildProviderAccountRows, parseQuotaText } from "../engine";
import { DollarRow, ProviderRows, SkeletonRows, observationAgeMinutes } from "../pieces";
import { claudeMeterOverride, meterName, type ClaudeMeterCopy } from "../language";
import { useClaudeMeterCopy } from "../use-claude-meter-copy";
import { InstallControl, runningInstalled } from "../install";
import { PhoneSettings } from "./phone-settings";
import { PhoneTabs, type PhoneTab } from "./phone-tabs";
import { ProTab } from "./pro-tab";
import { authStorageKey, readKeepSignedIn } from "@/lib/account-client";

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
 * in HttpOnly cookies. Every later open renews through phone_renew when
 * the token is within twelve hours of its end or past it, and the bars render here
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
const BUTTON_SOLID = `${BUTTON} border-transparent bg-solid text-on-solid hover:bg-solid-hover disabled:opacity-50`;

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

/**
 * The eight characters typed by hand, inside the installed app.
 *
 * The backup for an icon that opened without the browser's pairing: older
 * iOS, an icon added before pairing, or a cookie copy that did not happen.
 * The field has no name, so even a form submitted without script puts
 * nothing in the address; the code leaves only in the claim's request body.
 */
function CodeEntry({
  note,
  label,
  action,
  onCode,
}: {
  note: string | null;
  label: string;
  action: string;
  onCode: (code: string) => void;
}) {
  const [value, setValue] = useState("");
  const code = pairCodeFromFragment(`code=${value}`);
  return (
    <form
      className={`${CARD} space-y-3`}
      onSubmit={(event) => {
        event.preventDefault();
        if (code !== null) onCode(code);
      }}
    >
      {note !== null && <p className="text-sm font-medium text-heading">{note}</p>}
      <label htmlFor="pair-code-entry" className="block text-sm text-muted">
        {label}
      </label>
      <input
        id="pair-code-entry"
        value={value}
        onChange={(event) => {
          setValue(event.target.value.toUpperCase().replace(/[^A-Z0-9]/gu, "").slice(0, 8));
        }}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        className="focus-ring w-full rounded-xl border border-hairline bg-code px-4 py-3 text-center font-mono text-xl tracking-widest text-heading"
      />
      <button type="submit" disabled={code === null} className={BUTTON_SOLID}>
        {action}
      </button>
    </form>
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
  staleLabel: string;
  now: string;
  freshLabel: string;
  staleStateLabel: string;
  unknownAgeLabel: string;
  ageLabel: (minutes: number) => string;
  stateAnnouncement: (state: string) => string;
  accountLabel: (count: number) => string;
  claudeMeterCopy?: ClaudeMeterCopy;
  claudeFableHintText?: string;
}

/**
 * The account's meters, drawn by the same row elements the desktop and the
 * browser dashboard draw, so one reading cannot look like two different
 * readings on two screens.
 */
function PhoneBars({ body, stale, locale, staleLabel, now, freshLabel, staleStateLabel, unknownAgeLabel, ageLabel, stateAnnouncement, accountLabel, claudeMeterCopy = {}, claudeFableHintText = "" }: PhoneBarsProps) {
  const rows = useMemo(
    () => meterRowsOf(body).map((row) => stale ? { ...row, stale: true } : row),
    [body, stale],
  );
  const snapshots = useMemo(() => {
    const raw = rows.map(snapshotFromMeterRow).filter((row) => row !== null);
    const parsed = parseQuotaText(JSON.stringify(raw), new Date().toISOString());
    // Lane A eligibility hook: the shared engine result becomes the only filter when that rule lands.
    return parsed.ok ? parsed.snapshots : [];
  }, [rows]);
  const money = useMemo(() => amountRows(rows, ENGINE_PROVIDERS), [rows]);
  const providerRows = useMemo(
    () => buildProviderAccountRows(snapshots, now, [], {
      accountLabel: (_accountId, count) => accountLabel(count),
      meterLabel: (code, provider) => claudeMeterOverride(code, provider, claudeMeterCopy),
      updatedLabel: (observedAt) => {
        const age = observationAgeMinutes(observedAt, now);
        return age !== null && age >= 5 ? ageLabel(age) : null;
      },
    }),
    [accountLabel, ageLabel, claudeMeterCopy, now, snapshots],
  );

  return (
    <section className="space-y-3" data-stale={stale ? "" : undefined} aria-label={stale ? staleLabel : undefined}>
      <div className="space-y-3">
        {snapshots.length > 0 && (
          <ProviderRows
            rows={providerRows}
            orderScope={{ kind: "paired", id: "current-device" }}
            reorderable
            layout="stacked"
            claudeFableHintText={claudeFableHintText}
          />
        )}
        {money.length > 0 && (
          <div className={`${CARD} ol-device-money`}>
            {money.map((row) => (
              <MoneyRow key={`${row.provider}:${row.accountId}:${row.code}`} row={row} locale={locale} now={now} offline={stale} freshLabel={freshLabel} staleStateLabel={staleStateLabel} unknownAgeLabel={unknownAgeLabel} ageLabel={ageLabel} stateAnnouncement={stateAnnouncement} claudeMeterCopy={claudeMeterCopy} />
            ))}
          </div>
        )}
        {snapshots.length === 0 && money.length === 0 && (
          <SkeletonRows />
        )}
      </div>
    </section>
  );
}

function MoneyRow({ row, locale, now, offline, freshLabel, staleStateLabel, unknownAgeLabel, ageLabel, stateAnnouncement, claudeMeterCopy }: { row: MeterRow; locale: string; now: string; offline: boolean; freshLabel: string; staleStateLabel: string; unknownAgeLabel: string; ageLabel: (minutes: number) => string; stateAnnouncement: (state: string) => string; claudeMeterCopy: ClaudeMeterCopy }) {
  const age = observationAgeMinutes(row.observedAt, now);
  const stale = offline || row.stale || age === null || age * 60_000 >= DEVICE_FRESH_MILLISECONDS;
  return (
    <DollarRow
      name={`${row.provider} ${meterName(row.code, row.provider, claudeMeterCopy)}`}
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
  lockup,
}: {
  label: string;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
  onUnpaired: () => void;
  initialBars: unknown;
  lockup: ReactNode;
}) {
  const [state, setState] = useState<PairedState>({
    phase: initialBars === null ? "reading" : "offline",
    bars: initialBars,
    generation: 0,
  });
  const locale = useRef("en");
  const claudeMeterCopy = useClaudeMeterCopy();
  const readingsT = useTranslations("hub");
  const [now, setNow] = useState(() => new Date().toISOString());
  const [tab, setTab] = useState<PhoneTab>("usage");
  const unpairedRef = useRef(onUnpaired);
  unpairedRef.current = onUnpaired;

  useEffect(() => {
    locale.current = navigator.language || "en";
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-ol-ready", "1");
    const runtime = createPhoneSessionRuntime();
    const unsubscribe = runtime.subscribe((answer) => {
      if (answer.kind === "revoked") {
        setState((previous) => ({ ...previous, bars: null, phase: "revoked" }));
      } else if (answer.kind === "unpaired") {
        unpairedRef.current();
      } else if (answer.kind === "fresh") {
        setState((previous) => ({ ...previous, bars: answer.body, phase: "ready", generation: previous.generation + 1 }));
      } else if (answer.kind === "empty") {
        setState((previous) => ({ ...previous, phase: "offline" }));
      }
    });
    runtime.start();
    const refreshClock = () => {
      if (document.visibilityState !== "hidden") setNow(new Date().toISOString());
    };
    const onVisibilityChange = () => refreshClock();
    const clock = window.setInterval(refreshClock, 10_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      unsubscribe();
      runtime.stop();
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return (
    <div className="ol-phone-app">
      <header className="ol-phone-header">
        {lockup}
        <div className="ol-phone-header-actions">
          {state.phase === "offline" && <span data-stale-mark="" className="ol-stale-pill">{t("pairPage.offline.staleMark")}</span>}
          <PhoneSettings label={label} onUnpaired={onUnpaired} />
        </div>
      </header>
      <main className="ol-phone-content">
        <section
          id="ol-phone-panel-usage"
          role="tabpanel"
          aria-labelledby="ol-phone-tab-usage"
          tabIndex={0}
          hidden={tab !== "usage"}
        >
        {state.phase === "revoked" ? (
          <Card title={t("pairPage.revoked.title")}>
            <p>{t("pairPage.revoked.body")}</p>
            <p>
              <Link href="/app" className={BUTTON_GHOST}>
                {t("pairPage.openDashboard")}
              </Link>
            </p>
          </Card>
        ) : state.bars === null && (state.phase === "reading" || state.phase === "renewing") ? (
          <SkeletonRows />
        ) : state.phase === "offline" && state.bars === null ? (
          <Card title={t("pairPage.offline.title")}>
            <p>{t("pairPage.offline.body")}</p>
          </Card>
        ) : (
          <div className="space-y-4">
            <InstallControl compact />
            <PhoneBars
              body={state.bars}
              stale={state.phase === "offline"}
              locale={locale.current}
              staleLabel={t("pairPage.offline.staleMark")}
              now={now}
              freshLabel={t("cloud.fresh")}
              staleStateLabel={t("cloud.stale")}
              unknownAgeLabel={t("cloud.observationUnknown")}
              ageLabel={(minutes) => t("cloud.observationAge", { minutes })}
              stateAnnouncement={(value) => t("cloud.stateAnnouncement", { state: value })}
              accountLabel={(count) => t("grid.account", { count })}
              claudeMeterCopy={claudeMeterCopy}
              claudeFableHintText={readingsT("claudeFableDesktopHint")}
            />
          </div>
        )}
        </section>
        <section
          id="ol-phone-panel-pro"
          role="tabpanel"
          aria-labelledby="ol-phone-tab-pro"
          tabIndex={0}
          hidden={tab !== "pro"}
        >
          <ProTab />
        </section>
      </main>
      <PhoneTabs active={tab} onSelect={setTab} />
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
  };
  if (typeof window === "undefined") return empty;
  const next = initialPairState(window.location.hash);
  if (window.location.hash !== "") {
    window.history.replaceState(null, "", window.location.pathname);
  }
  return next;
}

function hasHubSession(): boolean {
  const key = authStorageKey();
  if (key === null) return false;
  try {
    const storage = readKeepSignedIn() ? window.localStorage : window.sessionStorage;
    return storage.getItem(key) !== null;
  } catch { return false; }
}

export function PairFlow({ lockup = null }: { lockup?: ReactNode }) {
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
  /* Opened from the home screen icon, where no scan can bring a fragment. */
  const [installed] = useState(runningInstalled);

  /*
   * The claim itself, for a freshly scanned or typed code only.
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
        setPairedBars(readPhoneLastBars());
        setPairedLabel(meta.label);
        setCheckingExisting(false);
        return;
      }
      if (state.phase === "noCode" && hasHubSession()) {
        window.location.replace("/app");
        return;
      }
      const answer = await readCurrentPhoneBars(defaultLabel);
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
      if (live) {
        const next = pairStateAfterPoll(stateRef.current, response.body, response.status);
        const pair = next.phase === "approved" && next.session === null
          ? phonePairOf(response.body)
          : null;
        setState(next.phase === "approved" && pair === null ? { ...next, phase: "error", session: null } : next);
        if (pair !== null) {
          const label = pairDeviceMeta(browserMeta()).name;
          void establishPhoneSession(pair, label)
            .then((ok) => {
              if (ok) setPairedLabel(label);
              else setState((current) => ({ ...current, phase: "error" }));
            })
            .catch(() => {
              setState((current) => ({ ...current, phase: "error" }));
            })
            .finally(() => {
              pair.token = "";
              pair.refreshCredential = "";
            });
        }
      }
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

  if (pairedLabel !== null) {
    return (
      <PairedPhone
        label={pairedLabel}
        t={t}
        initialBars={pairedBars}
        lockup={lockup}
        onUnpaired={() => {
          setPairedLabel(null);
          setPairedBars(null);
          claimStarted.current = false;
          setRemaining(null);
          setCheckingExisting(false);
          setState(initialPairState(""));
        }}
      />
    );
  }

  /* Approved but the phone session is still being established: keep the
     reading card up rather than falling through to the error card. */
  if (checkingExisting || state.phase === "reading" || state.phase === "claiming" || state.phase === "approved") {
    return (
      <Card title={t("pairPage.setup.reading.title")} tone="accent">
        <p>{t("pairPage.setup.reading.body")}</p>
      </Card>
    );
  }

  const failed = state.phase === "expired" || state.phase === "denied" || state.phase === "error";
  if (installed && (state.phase === "noCode" || failed)) {
    return (
      <CodeEntry
        note={
          state.phase === "expired"
            ? t("pairPage.setup.expired.title")
            : state.phase === "denied"
              ? t("pairPage.setup.denied.title")
              : state.phase === "error"
                ? t("pairPage.setup.error.title")
                : null
        }
        label={t("pairPage.codeEntry.label")}
        action={t("pairPage.codeEntry.pair")}
        onCode={(code) => {
          /* The same claim a scanned fragment starts, from the same state. */
          claimStarted.current = false;
          setState(initialPairState(`code=${code}`));
        }}
      />
    );
  }

  if (state.phase === "noCode") {
    return (
      <Card title={t("pairPage.setup.noCode.title")}>
        <p>{t("pairPage.setup.noCode.body")}</p>
        <p>
          <Link href="/app" className={BUTTON_GHOST}>
            {t("pairPage.openDashboard")}
          </Link>
        </p>
      </Card>
    );
  }

  if (state.phase === "waiting") {
    return (
      <div className="space-y-4">
        <Card title={t("pairPage.setup.waiting.title")} tone="accent">
          <p>{t("pairPage.setup.waiting.computer")}</p>
          {state.code !== null && <CodeReadout code={state.code} />}
          <p>
            {t("pairPage.setup.waiting.check")}
            {remaining !== null && remaining > 0 && (
              <> {t("pairPage.setup.waiting.expires", { seconds: remaining })}</>
            )}
          </p>
        </Card>
        <p className="text-center text-xs text-muted">{t("pairPage.setup.waiting.access")}</p>
      </div>
    );
  }

  if (state.phase === "denied") {
    return (
      <Card title={t("pairPage.setup.denied.title")}>
        <p>{t("pairPage.setup.denied.body")}</p>
        <p>
          <Link href="/app" className={BUTTON_GHOST}>
            {t("pairPage.openDashboard")}
          </Link>
        </p>
      </Card>
    );
  }

  if (state.phase === "expired") {
    return (
      <Card title={t("pairPage.setup.expired.title")}>
        <p>{t("pairPage.setup.expired.body")}</p>
        <p>
          <Link href="/app" className={BUTTON_GHOST}>
            {t("pairPage.openDashboard")}
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card title={t("pairPage.setup.error.title")}>
      <p>{t("pairPage.setup.error.body")}</p>
      <p>
        <Link href="/app" className={BUTTON_GHOST}>
          {t("pairPage.openDashboard")}
        </Link>
      </p>
    </Card>
  );
}
