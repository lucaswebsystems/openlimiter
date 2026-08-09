"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  combine,
  dashboardView,
  parseQuotaText,
  sampleSnapshots,
  type Snapshot,
} from "./engine";
import {
  Button,
  CodeBlock,
  DemoDataChip,
  Panel,
  ProviderCard,
  providerName,
} from "./pieces";

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

export function Dashboard() {
  const [snapshots, setSnapshots] = useState<readonly Snapshot[]>([]);
  const [sample, setSample] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "bad"; message: string } | null>(null);
  const [now, setNow] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const stored = loadStored();
    setSnapshots(stored.snapshots);
    setSample(stored.sample);
    setNow(new Date().toISOString());
    const timer = window.setInterval(() => {
      setNow(new Date().toISOString());
    }, TICK_MILLISECONDS);
    return () => {
      window.clearInterval(timer);
    };
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
      const instant = new Date().toISOString();
      const result = parseQuotaText(incoming, instant);
      if (!result.ok) {
        setNote({ tone: "bad", message: messages[result.reason] });
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
    },
    [persist],
  );

  const loadSample = useCallback(() => {
    const instant = new Date().toISOString();
    const next = sampleSnapshots(instant);
    setSnapshots(next);
    setSample(true);
    setNow(instant);
    persist(next, true);
    setNote({
      tone: "ok",
      message:
        "Loaded the project's synthetic fixtures. No account, no credential and no real usage is involved.",
    });
  }, [persist]);

  const clear = useCallback(() => {
    setSnapshots([]);
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

  const view = useMemo(
    () => (now === null ? null : dashboardView(snapshots, now)),
    [snapshots, now],
  );

  const hasReadings = snapshots.length > 0;

  return (
    <div className="space-y-6">
      <Panel
        title="Give it a document"
        description="Paste a Claude Code statusline payload, a manual quota document, or the output of openlimiter export. Drop a JSON file on the box if that is easier."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={loadSample}>Load sample data</Button>
            <Button tone="quiet" onClick={clear} disabled={!hasReadings && text === ""}>
              Clear
            </Button>
          </div>
        }
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
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
            spellCheck={false}
            rows={6}
            placeholder={'{ "rate_limits": { "seven_day": { "utilization": 64, "resets_at": "..." } } }'}
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
            className={`mt-3 font-sans text-sm leading-relaxed ${
              note.tone === "bad" ? "text-heading" : "text-body"
            }`}
          >
            {note.message}
          </p>
        )}
      </Panel>

      <section aria-labelledby="readings">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="readings" className="font-sans text-base font-medium text-heading">
            Readings
          </h2>
          {sample && <DemoDataChip />}
        </div>
        {view === null ? (
          <p className="font-sans text-sm text-body">Reading the clock on this device.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {view.providers.map((provider) => (
              <ProviderCard key={provider.provider} view={provider} />
            ))}
          </div>
        )}
      </section>

      {view !== null && (
        <Panel
          title="What an agent would be told"
          description="This is the block the prompt hook injects, built here by the same adapter the command line tool uses. It carries bounded numbers, enum codes and timestamps, inside a boundary that tells the agent to treat the contents as untrusted."
          action={sample ? <DemoDataChip /> : undefined}
        >
          {view.agentContext === "" ? (
            <p className="font-sans text-sm leading-relaxed text-body">
              Nothing at all. Every provider is unknown, and silence beats noise, so
              the hook injects no block rather than a block full of guesses.
            </p>
          ) : (
            <div className="space-y-4">
              <CodeBlock label="UserPromptSubmit hook" text={view.agentContext} />
              <CodeBlock label="Statusline" text={view.statusline} />
            </div>
          )}
        </Panel>
      )}

      {view !== null && view.unknown.length > 0 && (
        <p className="font-sans text-sm leading-relaxed text-body">
          Unknown, and left that way on purpose:{" "}
          {view.unknown.map((code) => providerName(code)).join(", ")}. A missing
          reading never becomes a zero and never becomes an exhausted quota.
        </p>
      )}
    </div>
  );
}
