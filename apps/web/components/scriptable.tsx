"use client";

import { useState } from "react";
import { CliTranscript } from "./cli-transcript";
import { SectionHeading } from "./ui";
import { demoCapture, hookCapture, statuslineCapture, type CliCapture } from "@/lib/cli-capture";
import { reveal, revealGroup, revealSm } from "@/lib/motion";

/**
 * Fully scriptable.
 *
 * Three tabs over three real captures. Only the selected panel is in the tree
 * at all, so nothing on this section is ever rendered at zero opacity waiting
 * to be revealed, and a reader who never touches the tabs still sees a complete
 * panel on first paint.
 */

const tabs: readonly { label: string; capture: CliCapture }[] = [
  { label: "Snapshot", capture: demoCapture },
  { label: "Statusline", capture: statuslineCapture },
  { label: "Agent context", capture: hookCapture },
];

export function Scriptable() {
  const [active, setActive] = useState(0);
  const current = tabs[active];

  return (
    /* The heading, the tabs, the panel and the note arrive in that order, 70ms
       apart. The panel keeps its own reveal across a tab change: the observer
       marks the element, React only ever swaps the transcript inside it. */
    <section id="scriptable" {...revealGroup}>
      <SectionHeading
        title="Fully scriptable"
        lead="Everything the tool knows, it will print. A table for you, one line for a statusline, a bounded block for an agent, or plain JSON for anything else."
      />

      <div
        role="tablist"
        aria-label="Command line examples"
        className="mb-3 flex flex-wrap gap-2"
        {...revealSm}
      >
        {tabs.map((tab, index) => {
          const selected = index === active;
          return (
            <button
              key={tab.label}
              type="button"
              role="tab"
              id={`scriptable-tab-${index}`}
              aria-selected={selected}
              aria-controls="scriptable-panel"
              onClick={() => setActive(index)}
              className={`lift-sm focus-ring rounded-full border px-3 py-1.5 text-xs ${
                selected
                  ? "border-hairline-strong bg-surface text-heading"
                  : "border-hairline text-muted hover:border-hairline-strong hover:text-heading"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id="scriptable-panel"
        role="tabpanel"
        aria-labelledby={`scriptable-tab-${active}`}
        className="mb-3"
        {...reveal}
      >
        <CliTranscript capture={current.capture} />
      </div>

      <p className="max-w-lg text-xs leading-relaxed text-muted" {...revealSm}>
        Every block above is verbatim standard output, captured against the project&apos;s synthetic
        fixtures. Add <span className="font-mono text-2xs text-heading">export</span> for the same
        state as JSON, and <span className="font-mono text-2xs text-heading">doctor</span> when a
        connector stops parsing.
      </p>
    </section>
  );
}
