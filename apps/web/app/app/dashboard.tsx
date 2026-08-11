"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  combine,
  dashboardView,
  parseQuotaText,
  sampleSnapshots,
  type ProviderFailure,
  type Snapshot,
} from "./engine";
import { InstallControl } from "./install";
import {
  Button,
  CodeBlock,
  ConnectionList,
  DemoBanner,
  DemoDataChip,
  FirstRunState,
  HeaderStrip,
  MeterList,
  Panel,
  ProviderCard,
  ProviderCatalogue,
  SettingsMenu,
  SkeletonCards,
  Tabs,
  ViewSwitch,
  type TabDefinition,
  type ViewMode,
} from "./pieces";
import { CLAUDE_STATUSLINE_WIRING, providerName } from "./language";
import { ThemeToggle } from "@/components/theme-toggle";

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

/** Where the grid or list choice is remembered, on this device only. */
const STORAGE_VIEW_KEY = "openlimiter-app-view";

type Mode = "live" | "demo";

/** One frozen empty list, so demo mode does not rebuild the view every tick. */
const NO_FAILURES: readonly ProviderFailure[] = [];

function loadView(): ViewMode {
  if (typeof window === "undefined") return "grid";
  try {
    return window.localStorage.getItem(STORAGE_VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const TABS: readonly TabDefinition[] = [
  { id: "home", label: "Home" },
  { id: "connections", label: "Connections" },
  { id: "advanced", label: "Advanced" },
];

const messages = {
  empty: "Nothing was pasted, so there is nothing to read.",
  not_json:
    "That is not valid JSON. Paste the whole document, including its outer braces.",
  no_meters:
    "That parsed as JSON, but no bounded meter survived validation. Nothing is assumed from it, so every provider stays unknown.",
} as const;

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
   * one and says, in red, that the newer document was refused. Cleared on the
   * next successful read of that provider, and never stored, since a failure
   * is about a document rather than about the state of a quota. It belongs to
   * the live store only: a fixture cannot fail to parse.
   */
  const [failures, setFailures] = useState<readonly ProviderFailure[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "bad"; message: string } | null>(null);
  const [now, setNow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Grid until this device says otherwise, and the server has no device, so
     the stored choice is read after mount rather than during render. */
  const [view, setView] = useState<ViewMode>("grid");
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<string>("connections");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const textArea = useRef<HTMLTextAreaElement | null>(null);
  const busyTimer = useRef<number | null>(null);

  const demo = mode === "demo";

  useEffect(() => {
    migrateLegacy();
    const storedLive = loadStore(LIVE_KEY);
    const storedDemo = loadStore(DEMO_KEY);
    const storedMode = loadMode();
    setLive(storedLive);
    setDemoSnapshots(storedDemo);
    setMode(storedMode);
    setNow(new Date().toISOString());
    setView(loadView());

    const activeSnapshots = storedMode === "demo" ? storedDemo : storedLive;
    if (activeSnapshots.length > 0) {
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
  }, []);

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
    setNote(null);
  }, []);

  /**
   * Take in a document.
   *
   * Refused outright while demo mode is on. The alternative is to merge a real
   * reading into a synthetic list, which is the exact defect this rewrite
   * exists to remove, and silently leaving demo mode on somebody's behalf would
   * mean their paste lands on a screen they think is a fixture. So it says no,
   * in a sentence, and the banner overhead carries the way out.
   */
  const read = useCallback(
    (incoming: string) => {
      if (mode === "demo") {
        setNote({
          tone: "bad",
          message:
            "Demo mode is on, so this document was not read. Real readings are never mixed into synthetic ones. Leave demo mode and supply it again.",
        });
        return;
      }
      work(() => {
        const instant = new Date().toISOString();
        const result = parseQuotaText(incoming, instant);
        /* A refused reading is reported on its provider's own card, whether or
           not anything else in the same document survived. */
        setFailures(result.failures);
        if (!result.ok) {
          setNote({ tone: "bad", message: messages[result.reason] });
          setNow(instant);
          return;
        }
        setLive((current) => {
          const merged = combine(current, result.snapshots);
          saveStore(LIVE_KEY, merged);
          return merged;
        });
        setNow(instant);
        setNote({
          tone: "ok",
          message:
            "Read " +
            String(result.snapshots.length) +
            (result.snapshots.length === 1 ? " meter from " : " meters from ") +
            result.recognised.join(", ") +
            ".",
        });
        setTab("home");
      });
    },
    [mode, work],
  );

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
      }
      setNow(new Date().toISOString());
    });
  }, [mode, work]);

  /**
   * Turn demo mode on.
   *
   * It writes the fixtures to the demo key and sets the mode. It does not name
   * the live key, so there is no arrangement of this code in which entering
   * demo mode can touch a real reading.
   */
  const enterDemo = useCallback(() => {
    work(() => {
      const instant = new Date().toISOString();
      const next = sampleSnapshots(instant);
      setDemoSnapshots(next);
      saveStore(DEMO_KEY, next);
      setMode("demo");
      saveMode("demo");
      setNow(instant);
      setNote({
        tone: "ok",
        message:
          "Demo mode is on. These are the project's synthetic fixtures: no account, no credential and no real usage. Your own readings are kept where they are.",
      });
      setTab("home");
    });
  }, [work]);

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
  const clear = useCallback(() => {
    if (demo) {
      setDemoSnapshots([]);
    } else {
      setLive([]);
      setFailures([]);
    }
    setText("");
    setNote(null);
    setTab("connections");
    try {
      window.localStorage.removeItem(demo ? DEMO_KEY : LIVE_KEY);
    } catch {
      /* Nothing to clear if storage was never available. */
    }
  }, [demo]);

  const acceptFile = useCallback(
    (file: File | undefined) => {
      if (file === undefined) return;
      file
        .text()
        .then((contents) => {
          setText(contents);
          read(contents);
        })
        .catch(() => {
          setNote({ tone: "bad", message: "That file could not be read." });
        });
    },
    [read],
  );

  /** Remember the layout, on this device only, and apply it now. */
  const chooseView = useCallback((next: ViewMode) => {
    setView(next);
    try {
      window.localStorage.setItem(STORAGE_VIEW_KEY, next);
    } catch {
      /* Storage refused. The choice still applies to this page. */
    }
  }, []);

  const openConnections = useCallback(() => {
    setTab("connections");
  }, []);

  /* One store is on screen at a time, and this is where that is decided. */
  const shown = demo ? demoSnapshots : live;
  const shownFailures = demo ? NO_FAILURES : failures;

  /* The rendered shape of every reading. Named apart from `view` above, which
     is the layout choice: one is what is shown, the other is how. */
  const dash = useMemo(
    () => (now === null ? null : dashboardView(shown, now, shownFailures)),
    [shown, now, shownFailures],
  );

  const hasReadings = shown.length > 0 || shownFailures.length > 0;

  /**
   * The providers that earned a card.
   *
   * A provider with no reading and no failure has nothing to say, and a grid of
   * empty cards is the first launch defect the audit named: it reads as six
   * broken connections. They are accounted for in one quiet line underneath
   * instead.
   */
  const carded = useMemo(
    () =>
      (dash?.providers ?? []).filter(
        (provider) => provider.meters.length > 0 || provider.failure !== null,
      ),
    [dash],
  );

  const asOf = useMemo(() => {
    if (now === null) return null;
    const parsed = Date.parse(now);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : null;
  }, [now]);

  return (
    <div className="space-y-5">
      {demo && <DemoBanner onLeave={leaveDemo} />}

      <HeaderStrip
        lockup={lockup}
        advice={dash?.advice ?? null}
        asOf={asOf}
        demo={demo}
        busy={busy}
        onRefresh={refresh}
        actions={
          <>
            <ViewSwitch view={view} onSelect={chooseView} />
            <InstallControl />
            <ThemeToggle className="mr-1 h-9 w-9" />
            <SettingsMenu
              demo={demo}
              onEnterDemo={enterDemo}
              onLeaveDemo={leaveDemo}
              onClear={clear}
              /* Whether there is anything to forget is a question about the
                 store the button will actually name, so it is asked of that
                 store and not of the other one. */
              clearable={
                (demo
                  ? demoSnapshots.length > 0
                  : live.length > 0 || failures.length > 0) || text !== ""
              }
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
            <SkeletonCards />
          ) : hasReadings ? (
            <>
              {view === "list" ? (
                <MeterList providers={carded} now={now ?? ""} demo={demo} />
              ) : (
                <div className="ol-stagger grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {carded.map((provider) => (
                    <ProviderCard
                      key={provider.provider}
                      view={provider}
                      now={now ?? ""}
                      demo={demo}
                    />
                  ))}
                </div>
              )}
              {dash.unknown.length > 0 && (
                <p className="mt-4 text-xs leading-relaxed text-muted">
                  Not connected yet:{" "}
                  {dash.unknown.map((code) => providerName(code)).join(", ")}. A
                  provider with no reading gets no card and no number, because a
                  missing reading is not a zero and not an exhausted quota.{" "}
                  <button
                    type="button"
                    onClick={openConnections}
                    className="focus-ring cursor-pointer rounded text-accent underline-offset-2 hover:underline"
                  >
                    See what can be connected
                  </button>
                </p>
              )}
            </>
          ) : (
            <FirstRunState onConnect={openConnections} />
          )}
        </div>
      )}

      {tab === "connections" && (
        <div
          id="panel-connections"
          role="tabpanel"
          aria-labelledby="tab-connections"
          tabIndex={-1}
          className="ol-panel space-y-5"
        >
          <Panel
            title="Connections"
            description="What OpenLimiter can read today, and how. Manual entry, provider file imports, and demo mode. Nothing here signs in to anything, and no credential is stored on this page."
            demo={demo}
          >
            <ConnectionList
              onImportFile={() => fileInput.current?.click()}
              onEnterDemo={enterDemo}
            />
            {note !== null && (
              <p
                role="status"
                className={`mt-3 text-sm leading-relaxed ${
                  note.tone === "bad" ? "text-heading" : "text-body"
                }`}
              >
                {note.message}
              </p>
            )}
            <p className="mt-4 text-xs leading-relaxed text-muted">
              Every connector ships marked UNVERIFIED: no verifier has confirmed
              a shape against a live account yet. A shape that changes fails
              closed to unknown rather than guessing.
            </p>
          </Panel>

          <Panel
            title="Provider catalogue"
            description="Seventeen products, five of which this page can read from an imported document, twelve of which OpenLimiter does not read yet, and none of which this page can connect."
            demo={demo}
          >
            <ProviderCatalogue />
          </Panel>

          <Panel
            title="Why this browser holds no live connection"
            description="This page makes no request to any provider and stores no credential, and that is a decision, not a gap. Live connections belong in the desktop application."
            demo={demo}
          >
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <div>
                <h3 className="ol-brand-font text-sm text-heading">
                  Browsers refuse the request
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  Provider quota endpoints are not built to answer a web page
                  from another origin, and the browser enforces that boundary
                  itself: the cross origin rules stop the call before it
                  leaves. A page that promised live provider reads would be
                  promising a request the platform is designed to refuse.
                </p>
              </div>
              <div>
                <h3 className="ol-brand-font text-sm text-heading">
                  A page is the wrong place for a key
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  A key pasted into a page has to live in browser storage,
                  where any script that ever runs on this origin can read it.
                  The desktop application stores keys in the operating system
                  credential store, and after entry it only ever sees a masked
                  label.
                </p>
              </div>
            </div>
          </Panel>
        </div>
      )}

      {tab === "advanced" && (
        <div
          id="panel-advanced"
          role="tabpanel"
          aria-labelledby="tab-advanced"
          tabIndex={-1}
          className="ol-panel space-y-5"
        >
          <Panel
            title="Import a document"
            description="Paste a statusline payload, a manual quota document, or exported readings. Drop a JSON file on the box if that is easier."
            demo={demo}
          >
            {demo && (
              <p className="mb-3 text-sm leading-relaxed text-heading">
                Demo mode is on, so nothing pasted here is read. Leave demo mode
                first and your own readings come back exactly as they were.
              </p>
            )}
            <div
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => {
                setDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                acceptFile(event.dataTransfer.files[0]);
              }}
            >
              <label htmlFor="quota-input" className="sr-only">
                Quota document
              </label>
              <textarea
                id="quota-input"
                ref={textArea}
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                }}
                spellCheck={false}
                rows={8}
                placeholder={
                  '{ "rate_limits": { "seven_day": { "used_percentage": 64.2, "resets_at": 1760000000 } } }'
                }
                className={`focus-ring-inset w-full resize-y rounded-lg border bg-code p-3.5 font-mono text-xs leading-relaxed text-body outline-none transition-colors ${
                  dragging ? "border-accent-solid" : "border-hairline"
                }`}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                tone="primary"
                disabled={demo}
                onClick={() => {
                  read(text);
                }}
              >
                Read it
              </Button>
              <Button
                disabled={demo}
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                Choose a file
              </Button>
            </div>
            {note !== null && (
              <p
                role="status"
                className={`mt-3 text-sm leading-relaxed ${
                  note.tone === "bad" ? "text-heading" : "text-body"
                }`}
              >
                {note.message}
              </p>
            )}
          </Panel>

          <Panel
            title="Claude Code statusline configuration"
            description="On a machine running Claude Code, this wiring makes the reading arrive on its own. In this browser, paste the payload that command receives into the import box above."
            demo={demo}
          >
            <pre className="overflow-x-auto rounded-md border border-hairline bg-code p-3 font-mono text-xs leading-relaxed text-body">
              <code>{CLAUDE_STATUSLINE_WIRING}</code>
            </pre>
          </Panel>

          <Panel
            title="What an agent would be told"
            description="This is the block the prompt hook injects, built here by the same adapter the command line tool uses. It carries bounded numbers, enum codes and timestamps, inside a boundary that tells the agent to treat the contents as untrusted."
            action={demo ? <DemoDataChip /> : undefined}
            demo={demo}
          >
            {dash === null || dash.agentContext === "" ? (
              <p className="text-sm leading-relaxed text-body">
                Nothing at all. Every provider is unknown, and silence beats
                noise, so the hook injects no block rather than a block full of
                guesses.
              </p>
            ) : (
              <div className="space-y-4">
                <CodeBlock
                  label="UserPromptSubmit hook"
                  text={dash.agentContext}
                  synthetic={demo}
                />
                <CodeBlock label="Statusline" text={dash.statusline} synthetic={demo} />
              </div>
            )}
          </Panel>

          <Panel title="Where a document comes from">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
              <div>
                <h3 className="ol-brand-font text-sm text-heading">From the tool</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  Run{" "}
                  <code className="font-mono text-xs text-heading">
                    openlimiter export
                  </code>{" "}
                  and paste what it prints. That is the whole cache, already
                  validated once.
                </p>
              </div>
              <div>
                <h3 className="ol-brand-font text-sm text-heading">From your agent</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  A Claude Code statusline payload works as it is, including the
                  rate limit block it already carries.
                </p>
              </div>
              <div>
                <h3 className="ol-brand-font text-sm text-heading">From your own notes</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  A manual quota document covers a provider with no interface at
                  all. You write down what you know, it does the arithmetic.
                </p>
              </div>
            </div>
            <p className="mt-5 text-sm leading-relaxed text-muted">
              On the same network as the machine doing the work? Run{" "}
              <code className="font-mono text-xs text-heading">
                openlimiter serve
              </code>{" "}
              there and scan the code it prints. Your phone then reads the live
              quota on that machine directly, with no cloud in the middle.
            </p>
          </Panel>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json,.txt"
        className="sr-only"
        onChange={(event) => {
          acceptFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );
}
