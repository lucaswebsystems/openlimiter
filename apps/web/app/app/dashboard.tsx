"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  PROVIDER_CODES,
  buildProviderAccountRows,
  dashboardView,
  parseQuotaText,
  sampleSnapshots,
  type ProviderDirectoryRow,
  type ProviderFailure,
  type Snapshot,
} from "./engine";
import { InstallControl } from "./install";
import {
  BackGlyph,
  Button,
  DemoBanner,
  GearGlyph,
  HeaderStrip,
  IconButton,
  Panel,
  PlusGlyph,
  ProviderDirectory,
  ProviderRows,
  SettingsMenu,
  SkeletonRows,
} from "./pieces";
import { BarsEmpty, ConnectList } from "./connect";
import { Onboarding } from "./onboarding";
import { SignInCard } from "@/components/sign-in-card";
import { ThemeToggle } from "@/components/theme-toggle";
import { SectionPanel } from "@/components/ui";
import { LiveMeter } from "./live-meter";
import { NotificationBell, type AlertScope } from "./notification-bell";
import {
  applyKeepSignedIn,
  createAccountClient,
  readKeepSignedIn,
  resumeAccountClient,
  stopAccountClient,
  writeKeepSignedIn,
} from "@/lib/account-client";
import {
  ONBOARDED_METADATA_KEY,
  hasOnboarded,
  openingView,
  rememberOnboarded,
  type AccountProfile,
  type FlagStore,
  type HubView,
} from "@/lib/onboarding";
import {
  readSyncedUsage,
  type SyncedProviderUsage,
  type SyncedUsageResult,
} from "@/lib/synced-usage";
import { getDevPreviewSnapshots } from "./dev-preview";
import { useTranslations } from "next-intl";

const IS_DEV = process.env.NODE_ENV !== "production";

/**
 * The dashboard.
 *
 * It is the command line tool's own engine, running in a tab. You hand it a
 * document, it validates that document with the same normalizer the CLI uses,
 * and it renders what survives. A reading that fails validation is dropped
 * rather than repaired, and a provider with nothing readable stays unknown.
 *
 * Everything happens in this tab. There is no request to any server, no
 * account, no analytics, and nothing is uploaded. The only thing that leaves
 * memory is the last reading, kept in this browser's own storage so an
 * installed copy of this page still has something to show when it reopens.
 *
 * LIVE AND DEMO ARE TWO STORES, NOT ONE STORE WITH A FLAG
 * ------------------------------------------------------
 * They used to share a key with a boolean beside it saying which kind the
 * contents were, and that arrangement had three separate ways of lying:
 *
 *   pasting a real document while sample data was loaded merged the two lists
 *   and then cleared the flag, so synthetic readings were relabelled as live;
 *
 *   loading sample data overwrote whatever real readings were stored, with no
 *   way back;
 *
 *   a browser that dropped the flag but kept the list, or the other way round,
 *   left synthetic numbers presented as an account.
 *
 * None of those are fixable with a better flag, because the flag is the bug. So
 * there are two keys now, they are written by two functions that each name
 * their own key, and nothing ever merges a snapshot from one into the other.
 * Which one is on screen is a mode, kept in a third key, and switching modes
 * reads a store rather than converting one. Entering demo mode cannot touch the
 * live store because it never names it.
 */

/** Where real readings live, on this device only. */
const LIVE_KEY = "openlimiter-app-live";

/** Where synthetic readings live. Never read as live, never merged into it. */
const DEMO_KEY = "openlimiter-app-demo";

/** Which of the two is on screen. */
const MODE_KEY = "openlimiter-app-mode";

/**
 * The single key the two used to share, and the flag that sat beside it.
 *
 * Read once, on first load, and then removed, whichever way it goes. What
 * happens in between depends on what the flag said, and the two cases are
 * opposites:
 *
 *   flag absent or "0", meaning the contents were real, and the live store is
 *   still empty: the contents are PROMOTED into the live store, so somebody
 *   upgrading does not lose the readings they had;
 *
 *   flag "1", meaning the contents were synthetic, or a live store that already
 *   holds something: the contents are dropped, because a store that cannot
 *   prove a reading came from an account is not allowed to hand it to the live
 *   store, and a real live store is never overwritten by an older one.
 */
const LEGACY_KEY = "openlimiter-app-snapshots";
const LEGACY_SAMPLE_KEY = "openlimiter-app-sample";

/** How often the clock advances, which is what ages a reading to stale. */
const TICK_MILLISECONDS = 10_000;

/**
 * How long a working state stays on screen at the least.
 *
 * Validating a document is usually over inside a frame, and a placeholder that
 * appears and vanishes inside two frames is a flicker rather than feedback. So
 * the skeleton is held for this long, and no longer: a document that genuinely
 * takes more than this keeps the skeleton until it is actually finished.
 */
const BUSY_FLOOR_MILLISECONDS = 240;

/** Set on the document once this component has mounted. Clears the splash. */
const READY_ATTR = "data-ol-ready";

const SYNC_FRESH_MILLISECONDS = 5 * 60_000;
const WEB_SYNC_KEY = "openlimiter-web-sync-enabled";

function snapshotsFromSync(providers: readonly SyncedProviderUsage[]): Snapshot[] {
  const supported = new Set<string>(PROVIDER_CODES);
  return providers.flatMap((provider) => {
    if (!supported.has(provider.provider)) return [];
    return provider.windows.map((window): Snapshot => ({
      provider: provider.provider as Snapshot["provider"],
      meter: window.windowName,
      value: window.percentage,
      unit: "PERCENT",
      window: { kind: "rolling" },
      resetAt: window.resetAt,
      source: "documented_api",
      precision: "exact",
      observedAt: window.observedAt,
      expiresAt: new Date(
        Date.parse(window.observedAt) + SYNC_FRESH_MILLISECONDS,
      ).toISOString(),
      accountId: provider.accountLabel,
      labels: {
        credentialOrigin: "official-local-tool",
        dataInterfaceStatus: "documented-api",
        automationRisk: "low",
        verification: "UNVERIFIED",
      },
      provenance: { sourceKind: "remote_api", observedVia: "remote_http" },
    }));
  });
}

type Mode = "live" | "demo";

/** One frozen empty list, so demo mode does not rebuild the view every tick. */
const NO_FAILURES: readonly ProviderFailure[] = [];

/**
 * This browser's own record of which accounts have been through the first run.
 *
 * A plain store rather than the local storage global, so every reader of it in
 * this file goes through the same guard and a browser with storage refused
 * simply answers no.
 */
function flagStore(): FlagStore | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The gate a signed out browser meets.
 *
 * It is the product's one sign in card, the same component the Pro portal
 * draws, so the two cannot drift apart. A deployment with no hosted address
 * has nothing to sign in to, and says so in the same shape rather than
 * offering buttons that lead nowhere.
 */
function AccountGate({
  client,
  keepSignedIn,
  onKeepSignedInChange,
}: {
  client: SupabaseClient | null;
  keepSignedIn: boolean;
  onKeepSignedInChange: (next: boolean) => Promise<boolean>;
}) {
  return (
    <section className="ol-account-gate" aria-label="Sign in">
      {client === null ? (
        <SectionPanel className="mx-auto w-full max-w-md">
          <h1 className="text-xl font-medium tracking-tight text-heading">Sign in to OpenLimiter</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Account sign in is not configured in this deployment. Every meter in the desktop
            app keeps working without one.
          </p>
        </SectionPanel>
      ) : (
        <SignInCard
          client={client}
          heading="h1"
          keepSignedIn={keepSignedIn}
          onKeepSignedInChange={onKeepSignedInChange}
        />
      )}
    </section>
  );
}

/**
 * Read one store back.
 *
 * Whatever comes out goes through the real validator again rather than being
 * trusted as it was written, so a store somebody edited by hand is worth
 * exactly as much as a document somebody pasted.
 */
function loadStore(key: string): Snapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result = parseQuotaText(JSON.stringify(parsed), new Date().toISOString());
    return result.ok ? [...result.snapshots] : [];
  } catch {
    return [];
  }
}

function saveStore(key: string, snapshots: readonly Snapshot[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(snapshots));
  } catch {
    /* A browser with storage refused simply keeps the reading in memory. */
  }
}

function loadMode(): Mode {
  if (typeof window === "undefined") return "live";
  try {
    return window.localStorage.getItem(MODE_KEY) === "demo" ? "demo" : "live";
  } catch {
    return "live";
  }
}

function saveMode(mode: Mode): void {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* The mode still applies to this page. */
  }
}

/**
 * Promote a single key store into the live key, or drop it if it was synthetic.
 *
 * Promotion is the point of this function: a reading the old flag called real
 * is carried over intact rather than thrown away, and only an empty live store
 * will accept it. Everything else about the legacy pair is removed either way,
 * so this runs once per browser and never again.
 */
function migrateLegacy(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if (raw === null) return;
    const wasSample = window.localStorage.getItem(LEGACY_SAMPLE_KEY) === "1";
    /* Readings the old flag called real are carried over into a live store that
       has nothing in it yet. Anything else is dropped. */
    if (!wasSample && window.localStorage.getItem(LIVE_KEY) === null) {
      window.localStorage.setItem(LIVE_KEY, raw);
    }
    window.localStorage.removeItem(LEGACY_KEY);
    window.localStorage.removeItem(LEGACY_SAMPLE_KEY);
  } catch {
    /* Nothing to migrate if storage was never available. */
  }
}

/** The way back from a place, under the panel it belongs to. */
function BackToBars({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="mt-4 flex justify-center">
      <Button tone="quiet" onClick={onClick}>
        <BackGlyph />
        {label}
      </Button>
    </div>
  );
}

export function Dashboard({ lockup }: { lockup: ReactNode }) {
  /**
   * The two stores, side by side in memory exactly as they are on disk.
   *
   * Nothing in this component ever combines them. `shown` below picks one.
   */
  const [live, setLive] = useState<readonly Snapshot[]>([]);
  const [demoSnapshots, setDemoSnapshots] = useState<readonly Snapshot[]>([]);
  const [mode, setMode] = useState<Mode>("live");
  /**
   * What the last document got wrong, per provider.
   *
   * Kept beside the readings rather than inside them, because a rejected
   * reading is not a reading: the provider's card still shows the last good
   * one and says that the newer document was refused. Cleared on the
   * next successful read of that provider, and never stored, since a failure
   * is about a document rather than about the state of a quota. It belongs to
   * the live store only: a fixture cannot fail to parse.
   */
  const [failures] = useState<readonly ProviderFailure[]>([]);
  const [now, setNow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which of the hub's views is on screen.
   *
   * Bars, always, unless this account has never been here: the first visit
   * opens the three step flow instead, and every visit after it lands on the
   * meters. Configuration and the connect list are places somebody goes,
   * reached from the header, rather than tabs sitting above the product.
   */
  const [view, setView] = useState<HubView>("bars");
  const [syncedUsage, setSyncedUsage] = useState<SyncedUsageResult | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState<ProviderDirectoryRow | null>(null);
  const busyTimer = useRef<number | null>(null);
  const t = useTranslations("hub");
  /**
   * Read on the first render that has a browser to read from. The skeleton is
   * what is on screen at that moment, and it says nothing about this value, so
   * there is no server rendered answer for it to disagree with.
   */
  const [keepSignedIn, setKeepSignedIn] = useState(() => readKeepSignedIn());
  /* Rebuilt when the switch moves: the store a session lands in is fixed when
     the client is constructed. See lib/account-client.ts. */
  const syncClient = useMemo(() => createAccountClient(keepSignedIn), [keepSignedIn]);
  /** The account the opening view was decided for, so a token refresh cannot
      throw somebody out of the screen they are reading. */
  const decidedFor = useRef<string | null>(null);
  /** The live auth listener, so a client being replaced takes its own with it. */
  const authListener = useRef<{ unsubscribe: () => void } | null>(null);

  const demo = mode === "demo";

  const [mounted, setMounted] = useState(false);
  const [isDevPreview, setIsDevPreview] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (IS_DEV && typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("preview") === "1" || window.location.search.includes("preview=1")) {
        setIsDevPreview(true);
      }
    }

    migrateLegacy();
    const storedLive = loadStore(LIVE_KEY);
    const storedDemo = loadStore(DEMO_KEY);
    const storedMode = loadMode();
    setLive(storedLive);
    setDemoSnapshots(storedDemo);
    setMode(storedMode);
    setSyncEnabled(window.localStorage.getItem(WEB_SYNC_KEY) !== "false");
    setNow(new Date().toISOString());

    /* The launch splash waits on this and nothing else. */
    document.documentElement.setAttribute(READY_ATTR, "1");
    const timer = window.setInterval(() => {
      setNow(new Date().toISOString());
    }, TICK_MILLISECONDS);
    return () => {
      window.clearInterval(timer);
      if (busyTimer.current !== null) window.clearTimeout(busyTimer.current);
    };
  }, [isDevPreview]);

  const refreshSyncedUsage = useCallback(() => {
    if (!syncEnabled) {
      setSyncedUsage({ ok: false, reason: "signed_out" });
      return;
    }
    /* A rejection is an answer too. Without this the first read failing would
       leave the working state on screen with nothing ever to replace it. */
    void readSyncedUsage(syncClient).then(setSyncedUsage, () =>
      setSyncedUsage({ ok: false, reason: "unavailable" }),
    );
  }, [syncClient, syncEnabled]);

  /**
   * Where a signed in reader lands, decided once per account.
   *
   * The auth client reports a session again on every token refresh, and a
   * refresh is not a new visit, so the answer is remembered against the
   * account it was given for. Without that, somebody reading the connect list
   * would be moved back to the bars by a background refresh.
   */
  const decideOpeningView = useCallback((next: Session | null) => {
    const user = next?.user ?? null;
    if (user === null) {
      decidedFor.current = null;
      return;
    }
    if (decidedFor.current === user.id) return;
    decidedFor.current = user.id;
    setView(openingView(hasOnboarded(user as AccountProfile, flagStore())));
  }, []);

  /**
   * Listen to one client, and be able to do it again.
   *
   * The switch detaches this before it touches storage, and a move that fails
   * attaches it back to the same client, so a browser that refused the write
   * is left with a client that is both refreshing and listening, exactly as it
   * was a moment earlier.
   */
  const attachAuthListener = useCallback(
    (client: SupabaseClient) => {
      const { data } = client.auth.onAuthStateChange((_event, next) => {
        setSession(next);
        decideOpeningView(next);
        window.setTimeout(refreshSyncedUsage, 0);
      });
      authListener.current = data.subscription;
    },
    [decideOpeningView, refreshSyncedUsage],
  );

  useEffect(() => {
    refreshSyncedUsage();
    if (syncClient === null) {
      setSession(null);
      return;
    }
    setSession(null);
    void syncClient.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session);
        decideOpeningView(data.session);
      })
      .catch(() => setSession(null));
    attachAuthListener(syncClient);
    window.addEventListener("focus", refreshSyncedUsage);
    return () => {
      /* The switch may already have dropped it. Unsubscribing twice is safe;
         leaving a listener attached to an abandoned client is not. */
      authListener.current?.unsubscribe();
      authListener.current = null;
      window.removeEventListener("focus", refreshSyncedUsage);
    };
  }, [attachAuthListener, decideOpeningView, refreshSyncedUsage, syncClient]);

  /**
   * Move the session, then swap the client. In that order, and not otherwise.
   *
   * The old client is silenced first, both halves of it: the refresh ticker,
   * because two clients spending one refresh token is a race whose loser signs
   * the reader out, and the listener, because a client mid handover reporting
   * a session change would send this component off deciding views on behalf of
   * a client that is about to be thrown away. Only then does the session move,
   * and only a move that actually landed is allowed to change the answer: a
   * store that refused gets the old client back, ticker and listener both, the
   * old preference kept, and the card a sentence to draw.
   */
  const changeKeepSignedIn = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (next === keepSignedIn) return true;
      await stopAccountClient(syncClient);
      authListener.current?.unsubscribe();
      authListener.current = null;
      if (!applyKeepSignedIn(next)) {
        await resumeAccountClient(syncClient);
        if (syncClient !== null) attachAuthListener(syncClient);
        return false;
      }
      writeKeepSignedIn(next);
      setKeepSignedIn(next);
      return true;
    },
    [attachAuthListener, keepSignedIn, syncClient],
  );

  /** Show the working state, then clear it no sooner than the floor above. */
  const work = useCallback((run: () => void) => {
    setBusy(true);
    if (busyTimer.current !== null) window.clearTimeout(busyTimer.current);
    busyTimer.current = window.setTimeout(() => {
      run();
      setBusy(false);
      busyTimer.current = null;
    }, BUSY_FLOOR_MILLISECONDS);
  }, []);

  const leaveDemo = useCallback(() => {
    setMode("live");
    saveMode("live");
  }, []);

  const enterDemo = useCallback(() => {
    const samples = sampleSnapshots(new Date().toISOString());
    setDemoSnapshots(samples);
    saveStore(DEMO_KEY, samples);
    setMode("demo");
    saveMode("demo");
    setView("bars");
  }, []);

  /**
   * Read the device again.
   *
   * There is no server to ask, so this re reads what this browser stored,
   * validates it once more with the same normalizer, and advances the clock,
   * which is what ages a reading past its own expiry. It reads whichever store
   * the current mode is showing, and never the other one.
   */
  const refresh = useCallback(() => {
    work(() => {
      if (mode === "demo") {
        setDemoSnapshots(loadStore(DEMO_KEY));
      } else {
        setLive(loadStore(LIVE_KEY));
        refreshSyncedUsage();
      }
      setNow(new Date().toISOString());
    });
  }, [mode, refreshSyncedUsage, work]);

  /**
   * Finish the first run, from any of its three exits.
   *
   * Two writes, and the order is the point: this browser is told first, so the
   * flow cannot reappear while the profile write is still in flight, and the
   * account is told second, so a second machine never repeats it. A profile
   * write that fails changes nothing here, which is why nothing waits on it.
   */
  const finishOnboarding = useCallback(
    (name?: string) => {
      const user = session?.user ?? null;
      if (user !== null) rememberOnboarded(user.id, flagStore());
      const named = name === undefined || name === "" ? {} : { full_name: name };
      void syncClient?.auth
        .updateUser({ data: { ...named, [ONBOARDED_METADATA_KEY]: true } })
        .catch(() => null);
      setView("bars");
    },
    [session, syncClient],
  );

  /** The name from the first screen, saved on its own so Later loses nothing. */
  const saveProfileName = useCallback(
    (name: string) => {
      if (name === "") return;
      void syncClient?.auth.updateUser({ data: { full_name: name } }).catch(() => null);
    },
    [syncClient],
  );

  const syncedSnapshots = useMemo(
    () => (syncedUsage?.ok === true ? snapshotsFromSync(syncedUsage.providers) : []),
    [syncedUsage],
  );
  const showingSync = syncEnabled && !demo && syncedSnapshots.length > 0;

  const devSnapshots = useMemo(
    () => (isDevPreview && now !== null ? getDevPreviewSnapshots(now) : []),
    [isDevPreview, now],
  );

  /* One trusted source is on screen at a time, and this is where that is decided. */
  const shown = isDevPreview
    ? devSnapshots
    : demo
      ? demoSnapshots
      : showingSync
        ? syncedSnapshots
        : live;
  const shownFailures = isDevPreview || demo || showingSync ? NO_FAILURES : failures;

  /* The rendered shape of every reading. */
  const dash = useMemo(
    () => (now === null ? null : dashboardView(shown, now, shownFailures)),
    [shown, now, shownFailures],
  );

  const hasReadings = shown.length > 0 || shownFailures.length > 0;

  const providerRows = useMemo(
    () =>
      now === null
        ? []
        : buildProviderAccountRows(shown, now, shownFailures, { demo: demo || isDevPreview }),
    [shown, now, shownFailures, demo, isDevPreview],
  );

  const alertScopes = useMemo(() => {
    const scopes = new Map<string, AlertScope>();
    for (const snapshot of shown) {
      if (snapshot.unit !== "PERCENT") continue;
      const key = `${snapshot.provider}\u001f${snapshot.meter}`;
      scopes.set(key, {
        provider: snapshot.provider,
        meter: snapshot.meter,
        label: `${snapshot.provider} ${snapshot.meter}`,
      });
    }
    return [...scopes.values()];
  }, [shown]);

  const effectiveSession =
    isDevPreview && IS_DEV
      ? ({ user: { id: "preview", email: "preview@openlimiter.com" } } as unknown as Session)
      : session;

  /**
   * The bars themselves, drawn once and shown in two places.
   *
   * The last onboarding screen and the hub's own bars view are the same thing,
   * so they are the same markup: what somebody is shown at the end of the flow
   * is exactly what they land on afterwards, rather than a picture of it.
   */
  /* A read that has not answered yet is not an empty account. Until the first
     one comes back the panel holds the skeleton, so nobody is told to run a
     command a second before their own bars arrive. */
  const awaitingFirstRead =
    syncEnabled && !demo && !isDevPreview && syncedUsage === null;

  const barsPanel =
    busy || dash === null || awaitingFirstRead ? (
      <SkeletonRows />
    ) : hasReadings ? (
      <div className="ol-home-stack">
        <LiveMeter snapshots={shown} now={now} demo={demo} />
        <ProviderRows rows={providerRows} />
      </div>
    ) : (
      <BarsEmpty />
    );

  if (!mounted || effectiveSession === undefined) {
    return <div className="ol-dashboard"><SkeletonRows /></div>;
  }

  if (effectiveSession === null) {
    return (
      <div className="ol-dashboard">
        <HeaderStrip
          lockup={lockup}
          busy={false}
          onRefresh={() => {}}
          showRefresh={false}
          actions={<ThemeToggle className="h-9 w-9" />}
        />
        <AccountGate
          client={syncClient}
          keepSignedIn={keepSignedIn}
          onKeepSignedInChange={changeKeepSignedIn}
        />
      </div>
    );
  }

  return (
    <div className="ol-dashboard">
      {demo && <DemoBanner onLeave={leaveDemo} />}

      <HeaderStrip
        lockup={lockup}
        busy={busy}
        onRefresh={refresh}
        actions={
          <>
            {/* The name is carried by the control rather than by its text,
                because the text is dropped at the phone width and a button
                whose only label is display:none has no accessible name. */}
            {view === "bars" && (
              <Button tone="ghost" label={t("addAccount")} onClick={() => setView("connect")}>
                <PlusGlyph />
                <span className="hidden lg:inline">{t("addAccount")}</span>
              </Button>
            )}
            {syncClient !== null && <NotificationBell client={syncClient} scopes={alertScopes} />}
            <InstallControl />
            <ThemeToggle className="h-9 w-9" />
            {/* Not offered during the first run. Reaching configuration from
                there would leave the flow without finishing it, and an
                unfinished flow opens again on the next visit. Later and Skip
                are the ways out, and both record that it is done. */}
            {view !== "onboarding" && (
              <IconButton
                label={t("configuration")}
                pressed={view === "configuration"}
                onClick={() => setView(view === "configuration" ? "bars" : "configuration")}
              >
                <GearGlyph />
              </IconButton>
            )}
            <SettingsMenu
              accountEmail={effectiveSession.user.email ?? "Signed in"}
              syncEnabled={syncEnabled}
              onSyncChange={(enabled) => {
                setSyncEnabled(enabled);
                window.localStorage.setItem(WEB_SYNC_KEY, enabled ? "true" : "false");
              }}
              onCheckUpdate={() => {
                if (navigator.serviceWorker === undefined) return;
                void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
                  await Promise.all(registrations.map((registration) => registration.update()));
                  window.location.reload();
                });
              }}
              onLogout={() => {
                void syncClient?.auth.signOut();
              }}
            />
          </>
        }
      />

      <p role="status" aria-live="polite" className="sr-only">
        {busy ? "Reading." : "Ready."}
      </p>

      {view === "onboarding" && (
        <div className="ol-panel">
          <Onboarding
            profile={effectiveSession.user as AccountProfile}
            bars={barsPanel}
            onSaveName={saveProfileName}
            onFinish={finishOnboarding}
          />
        </div>
      )}

      {view === "bars" && <div className="ol-panel">{barsPanel}</div>}

      {view === "connect" && (
        <div className="ol-panel">
          <Panel title={t("connect.title")} description={t("connect.lead")} demo={demo}>
            <ConnectList />
          </Panel>
          <BackToBars label={t("backToBars")} onClick={() => setView("bars")} />
        </div>
      )}

      {view === "configuration" && (
        <div className="ol-panel">
          <Panel title="Providers" demo={demo}>
            <ProviderDirectory
              onConnect={setSelectedProvider}
              onManual={setSelectedProvider}
              onEnterDemo={enterDemo}
            />
            {selectedProvider !== null && (
              <section className="ol-connect-prompt" aria-live="polite">
                <div>
                  <span className="ol-directory-access" data-access={selectedProvider.access}>
                    {selectedProvider.accessLabel}
                  </span>
                  <strong>{selectedProvider.displayName}</strong>
                </div>
                <p>
                  {selectedProvider.access === "automatic"
                    ? "Open the desktop app. Local detection starts there."
                    : "Open the desktop app. Your key stays in the system credential store."}
                </p>
                <div className="ol-connect-prompt-actions">
                  <Button
                    tone="primary"
                    onClick={() => {
                      window.location.assign("/en/download");
                    }}
                  >
                    Get desktop
                  </Button>
                  <Button tone="ghost" onClick={() => setSelectedProvider(null)}>
                    Close
                  </Button>
                </div>
              </section>
            )}
          </Panel>
          <BackToBars label={t("backToBars")} onClick={() => setView("bars")} />
        </div>
      )}

    </div>
  );
}
