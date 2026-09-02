"use client";

import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
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
  Button,
  DemoBanner,
  FirstRunState,
  HeaderStrip,
  Panel,
  ProviderDirectory,
  ProviderRows,
  SettingsMenu,
  SkeletonRows,
  Tabs,
  type TabDefinition,
} from "./pieces";
import { ThemeToggle } from "@/components/theme-toggle";
import { LiveMeter } from "./live-meter";
import { NotificationBell, type AlertScope } from "./notification-bell";
import {
  createSyncClient,
  readSyncedUsage,
  type SyncedProviderUsage,
  type SyncedUsageResult,
} from "@/lib/synced-usage";
import { getDevPreviewSnapshots } from "./dev-preview";

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

const TABS: readonly TabDefinition[] = [
  { id: "home", label: "Home" },
  { id: "connections", label: "Configuration" },
];

function AccountGate({ client }: { client: SupabaseClient | null }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function oauth(provider: "google" | "github") {
    if (client === null) return;
    setBusy(true);
    setMessage("");
    const { error } = await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.href.split("?")[0] },
    });
    if (error !== null) {
      setBusy(false);
      setMessage("Sign in could not be started.");
    }
  }

  async function emailSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (client === null || email.trim() === "") return;
    setBusy(true);
    setMessage("");
    const { error } = await client.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.href.split("?")[0] },
    });
    setBusy(false);
    setMessage(error === null ? "Check your email to finish signing in." : "Email sign in is unavailable.");
  }

  return (
    <section className="ol-account-gate" aria-labelledby="account-gate-title">
      <h1 id="account-gate-title">Sign in to OpenLimiter</h1>
      <p>Your free account shows synced usage percentages on every device.</p>
      {client === null ? (
        <p>Account sign in is not configured in this deployment.</p>
      ) : (
        <>
          <div className="ol-account-provider-actions">
            <Button disabled={busy} onClick={() => void oauth("google")}>Continue with Google</Button>
            <Button disabled={busy} onClick={() => void oauth("github")}>Continue with GitHub</Button>
          </div>
          <form onSubmit={emailSignIn} className="ol-account-email-form">
            <label htmlFor="account-email">Email</label>
            <input
              id="account-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="focus-ring ol-account-email"
            />
            <button
              type="submit"
              disabled={busy}
              className="ol-control ol-control-primary ol-tap focus-ring border text-sm font-medium"
            >
              Sign in or create with email
            </button>
          </form>
          <p role="status">{message}</p>
        </>
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
  const [tab, setTab] = useState<string>("connections");
  const [syncedUsage, setSyncedUsage] = useState<SyncedUsageResult | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [selectedProvider, setSelectedProvider] = useState<ProviderDirectoryRow | null>(null);
  const busyTimer = useRef<number | null>(null);
  const syncClient = useMemo(() => createSyncClient(), []);

  const demo = mode === "demo";

  const isDevPreview = useMemo(() => {
    if (!IS_DEV || typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return params.get("preview") === "1" || window.location.search.includes("preview=1");
  }, []);

  useEffect(() => {
    migrateLegacy();
    const storedLive = loadStore(LIVE_KEY);
    const storedDemo = loadStore(DEMO_KEY);
    const storedMode = loadMode();
    setLive(storedLive);
    setDemoSnapshots(storedDemo);
    setMode(storedMode);
    setSyncEnabled(window.localStorage.getItem(WEB_SYNC_KEY) !== "false");
    setNow(new Date().toISOString());

    const activeSnapshots = storedMode === "demo" ? storedDemo : storedLive;
    if (isDevPreview || activeSnapshots.length > 0) {
      setTab("home");
    } else {
      setTab("connections");
    }

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
    void readSyncedUsage(syncClient).then((result) => {
      setSyncedUsage(result);
      if (result.ok && result.providers.length > 0) setTab("home");
    });
  }, [syncClient, syncEnabled]);

  useEffect(() => {
    refreshSyncedUsage();
    if (syncClient === null) {
      setSession(null);
      return;
    }
    setSession(null);
    void syncClient.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => setSession(null));
    const { data } = syncClient.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      window.setTimeout(refreshSyncedUsage, 0);
    });
    window.addEventListener("focus", refreshSyncedUsage);
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener("focus", refreshSyncedUsage);
    };
  }, [refreshSyncedUsage, syncClient]);

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
    setTab("home");
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
   * Forget whichever store is on screen, and only that one.
   *
   * THE MODE DECIDES THE KEY, AND IT HAS TO
   * ---------------------------------------
   * This used to name LIVE_KEY unconditionally. Clearing while demo mode was on
   * therefore destroyed the real readings sitting behind the synthetic view: the
   * screen did not change, because the screen was showing fixtures, so the one
   * signal that something had been deleted was absent at exactly the moment it
   * mattered. The banner overhead promises the live store is untouched, and a
   * button in the same window quietly emptied it.
   *
   * So the key is chosen by the mode, the same way `refresh` and `shown` choose
   * theirs, and the button in the settings panel says which store it is about to
   * forget. Demo mode never names the live key and live mode never names the
   * demo key, which is the same rule the rest of this file already keeps.
   */
  const openConnections = useCallback(() => {
    setTab("connections");
  }, []);

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
      ? ({ user: { email: "preview@openlimiter.com" } } as unknown as Session)
      : session;

  if (effectiveSession === undefined) {
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
        <AccountGate client={syncClient} />
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
            {syncClient !== null && <NotificationBell client={syncClient} scopes={alertScopes} />}
            <InstallControl />
            <ThemeToggle className="mr-1 h-9 w-9" />
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

      <Tabs tabs={TABS} active={tab} onSelect={setTab} />

      <p role="status" aria-live="polite" className="sr-only">
        {busy ? "Reading." : "Ready."}
      </p>

      {tab === "home" && (
        <div
          id="panel-home"
          role="tabpanel"
          aria-labelledby="tab-home"
          tabIndex={-1}
          className="ol-panel"
        >
          {busy || dash === null ? (
            <SkeletonRows />
          ) : (
            <div className="ol-home-stack">
              {!hasReadings && <FirstRunState onConnect={openConnections} />}
              {hasReadings && <LiveMeter snapshots={shown} now={now} demo={demo} />}
              <ProviderRows rows={providerRows} />
            </div>
          )}
        </div>
      )}

      {tab === "connections" && (
        <div
          id="panel-connections"
          role="tabpanel"
          aria-labelledby="tab-connections"
          tabIndex={-1}
          className="ol-panel"
        >
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
        </div>
      )}

    </div>
  );
}
