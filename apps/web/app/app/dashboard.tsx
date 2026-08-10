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
  DemoDataChip,
  EmptyState,
  HeaderStrip,
  MeterList,
  Panel,
  ProviderCard,
  SkeletonCards,
  Tabs,
  ViewSwitch,
  type TabDefinition,
  type ViewMode,
} from "./pieces";
import { providerName } from "./language";
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
 */

/** Where the last reading is kept, on this device only. */
const STORAGE_KEY = "openlimiter-app-snapshots";
const STORAGE_SAMPLE_KEY = "openlimiter-app-sample";

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

function loadView(): ViewMode {
  if (typeof window === "undefined") return "grid";
  try {
    return window.localStorage.getItem(STORAGE_VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

const TABS: readonly TabDefinition[] = [
  { id: "meters", label: "Meters" },
  { id: "context", label: "Agent context" },
  { id: "ingest", label: "Ingest" },
];

const messages = {
  empty: "Nothing was pasted, so there is nothing to read.",
  not_json:
    "That is not valid JSON. Paste the whole document, including its outer braces.",
  no_meters:
    "That parsed as JSON, but no bounded meter survived validation. Nothing is assumed from it, so every provider stays unknown.",
} as const;

function loadStored(): { snapshots: Snapshot[]; sample: boolean } {
  if (typeof window === "undefined") return { snapshots: [], sample: false };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { snapshots: [], sample: false };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { snapshots: [], sample: false };
    return {
      /* Read back through the real validator, never trusted as it was stored. */
      snapshots: parseStored(parsed),
      sample: window.localStorage.getItem(STORAGE_SAMPLE_KEY) === "1",
    };
  } catch {
    return { snapshots: [], sample: false };
  }
}

function parseStored(value: unknown[]): Snapshot[] {
  const result = parseQuotaText(JSON.stringify(value), new Date().toISOString());
  return result.ok ? [...result.snapshots] : [];
}

export function Dashboard({ lockup }: { lockup: ReactNode }) {
  const [snapshots, setSnapshots] = useState<readonly Snapshot[]>([]);
  /**
   * What the last document got wrong, per provider.
   *
   * Kept beside the readings rather than inside them, because a rejected
   * reading is not a reading: the provider's card still shows the last good
   * one and says, in red, that the newer document was refused. Cleared on the
   * next successful read of that provider, and never stored, since a failure
   * is about a document rather than about the state of a quota.
   */
  const [failures, setFailures] = useState<readonly ProviderFailure[]>([]);
  const [sample, setSample] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "bad"; message: string } | null>(null);
  const [now, setNow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Grid until this device says otherwise, and the server has no device, so
     the stored choice is read after mount rather than during render. */
  const [view, setView] = useState<ViewMode>("grid");
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<string>("meters");
  const fileInput = useRef<HTMLInputElement | null>(null);
  const textArea = useRef<HTMLTextAreaElement | null>(null);
  const busyTimer = useRef<number | null>(null);

  useEffect(() => {
    const stored = loadStored();
    setSnapshots(stored.snapshots);
    setSample(stored.sample);
    setNow(new Date().toISOString());
    setView(loadView());
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

  const persist = useCallback((next: readonly Snapshot[], isSample: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.localStorage.setItem(STORAGE_SAMPLE_KEY, isSample ? "1" : "0");
    } catch {
      /* A browser with storage refused simply keeps the reading in memory. */
    }
  }, []);

  const read = useCallback(
    (incoming: string) => {
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
        setSnapshots((current) => {
          const merged = combine(current, result.snapshots);
          persist(merged, false);
          return merged;
        });
        setSample(false);
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
        setTab("meters");
      });
    },
    [persist, work],
  );

  /**
   * Read the device again.
   *
   * There is no server to ask, so this re reads what this browser stored,
   * validates it once more with the same normalizer, and advances the clock,
   * which is what ages a reading past its own expiry. It is the same button
   * the desktop window carries, doing the same job against the one source each
   * surface actually has.
   */
  const refresh = useCallback(() => {
    work(() => {
      const stored = loadStored();
      setSnapshots(stored.snapshots);
      setSample(stored.sample);
      setNow(new Date().toISOString());
    });
  }, [work]);

  const loadSample = useCallback(() => {
    work(() => {
      const instant = new Date().toISOString();
      const next = sampleSnapshots(instant);
      setSnapshots(next);
      setFailures([]);
      setSample(true);
      setNow(instant);
      persist(next, true);
      setNote({
        tone: "ok",
        message:
          "Loaded the project's synthetic fixtures. No account, no credential and no real usage is involved.",
      });
      setTab("meters");
    });
  }, [persist, work]);

  const clear = useCallback(() => {
    setSnapshots([]);
    setFailures([]);
    setSample(false);
    setText("");
    setNote(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(STORAGE_SAMPLE_KEY);
    } catch {
      /* Nothing to clear if storage was never available. */
    }
  }, []);

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

  const openIngest = useCallback(() => {
    setTab("ingest");
    window.setTimeout(() => {
      textArea.current?.focus();
    }, 0);
  }, []);

  /* The rendered shape of every reading. Named apart from `view` above, which
     is the layout choice: one is what is shown, the other is how. */
  const dash = useMemo(
    () => (now === null ? null : dashboardView(snapshots, now, failures)),
    [snapshots, now, failures],
  );

  const hasReadings = snapshots.length > 0 || failures.length > 0;
  const asOf = useMemo(() => {
    if (now === null) return null;
    const parsed = Date.parse(now);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : null;
  }, [now]);

  return (
    <div className="space-y-5">
      <HeaderStrip
        lockup={lockup}
        advice={dash?.advice ?? null}
        asOf={asOf}
        sample={sample}
        busy={busy}
        onRefresh={refresh}
        actions={
          <>
            <ViewSwitch view={view} onSelect={chooseView} />
            <InstallControl />
            <ThemeToggle className="mr-1 h-9 w-9" />
          </>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs tabs={TABS} active={tab} onSelect={setTab} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={loadSample}>Load sample data</Button>
          <Button tone="quiet" onClick={clear} disabled={!hasReadings && text === ""}>
            Clear
          </Button>
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {busy ? "Reading." : "Ready."}
      </p>

      {tab === "meters" && (
        <div
          id="panel-meters"
          role="tabpanel"
          aria-labelledby="tab-meters"
          tabIndex={-1}
          className="ol-panel"
        >
          {busy || dash === null ? (
            <SkeletonCards />
          ) : hasReadings ? (
            <>
              {view === "list" ? (
                <MeterList providers={dash.providers} now={now ?? ""} />
              ) : (
                <div className="ol-stagger grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {dash.providers.map((provider) => (
                    <ProviderCard key={provider.provider} view={provider} now={now ?? ""} />
                  ))}
                </div>
              )}
              {dash.unknown.length > 0 && (
                <p className="mt-4 text-xs leading-relaxed text-muted">
                  Unknown, and left that way on purpose:{" "}
                  {dash.unknown.map((code) => providerName(code)).join(", ")}. A
                  missing reading never becomes a zero and never becomes an
                  exhausted quota.
                </p>
              )}
            </>
          ) : (
            <EmptyState onPaste={openIngest} onSample={loadSample} />
          )}
        </div>
      )}

      {tab === "context" && (
        <div
          id="panel-context"
          role="tabpanel"
          aria-labelledby="tab-context"
          tabIndex={-1}
          className="ol-panel"
        >
          <Panel
            title="What an agent would be told"
            description="This is the block the prompt hook injects, built here by the same adapter the command line tool uses. It carries bounded numbers, enum codes and timestamps, inside a boundary that tells the agent to treat the contents as untrusted."
            action={sample ? <DemoDataChip /> : undefined}
          >
            {dash === null || dash.agentContext === "" ? (
              <p className="text-sm leading-relaxed text-body">
                Nothing at all. Every provider is unknown, and silence beats
                noise, so the hook injects no block rather than a block full of
                guesses.
              </p>
            ) : (
              <div className="space-y-4">
                <CodeBlock label="UserPromptSubmit hook" text={dash.agentContext} />
                <CodeBlock label="Statusline" text={dash.statusline} />
              </div>
            )}
          </Panel>
        </div>
      )}

      {tab === "ingest" && (
        <div
          id="panel-ingest"
          role="tabpanel"
          aria-labelledby="tab-ingest"
          tabIndex={-1}
          className="ol-panel space-y-5"
        >
          <Panel
            title="Give it a document"
            description="Paste a Claude Code statusline payload, a manual quota document, or the output of openlimiter export. Drop a JSON file on the box if that is easier."
          >
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
                  '{ "rate_limits": { "seven_day": { "utilization": 64, "resets_at": "..." } } }'
                }
                className={`focus-ring-inset w-full resize-y rounded-lg border bg-code p-3.5 font-mono text-xs leading-relaxed text-body outline-none transition-colors ${
                  dragging ? "border-accent-solid" : "border-hairline"
                }`}
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                tone="primary"
                onClick={() => {
                  read(text);
                }}
              >
                Read it
              </Button>
              <Button
                onClick={() => {
                  fileInput.current?.click();
                }}
              >
                Choose a file
              </Button>
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
    </div>
  );
}
