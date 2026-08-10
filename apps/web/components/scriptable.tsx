"use client";

import { useState, type ReactNode } from "react";
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
 *
 * THIS IS A CLIENT COMPONENT, SO ITS COPY ARRIVES AS PROPS
 * -----------------------------------------------------------
 * `useTranslations` needs the request scoped context a Server Component render
 * has and a Client Component does not, so every string a reader sees here,
 * the heading, the tab labels and the closing note, is read from the `scriptable`
 * catalog by whichever Server Component renders `<Scriptable>` and handed down
 * already resolved. `note` in particular is a `t.rich` result: the message
 * carries two `<code>` spans (`export`, `doctor`), so the caller resolves it to
 * a finished node with `t.rich("note", { code: (chunks) => <span
 * className="font-mono text-2xs text-heading">{chunks}</span> })` and passes
 * the node down whole, rather than this file assembling it from parts.
 *
 * No Server Component in this pass's file list renders `<Scriptable>`, so the
 * call site that supplies these props belongs to another lane's edit.
 */

interface ScriptableTabLabels {
  snapshot: string;
  statusline: string;
  agentContext: string;
}

export interface ScriptableProps {
  title: string;
  lead: string;
  tablistAriaLabel: string;
  tabLabels: ScriptableTabLabels;
  /** The closing note, already resolved rich text (see the note above). */
  note: ReactNode;
}

export function Scriptable({ title, lead, tablistAriaLabel, tabLabels, note }: ScriptableProps) {
  const tabs: readonly { key: keyof ScriptableTabLabels; label: string; capture: CliCapture }[] = [
    { key: "snapshot", label: tabLabels.snapshot, capture: demoCapture },
    { key: "statusline", label: tabLabels.statusline, capture: statuslineCapture },
    { key: "agentContext", label: tabLabels.agentContext, capture: hookCapture },
  ];

  const [active, setActive] = useState(0);
  const current = tabs[active];

  return (
    /* The heading, the tabs, the panel and the note arrive in that order, 70ms
       apart. The panel keeps its own reveal across a tab change: the observer
       marks the element, React only ever swaps the transcript inside it. */
    <section id="scriptable" {...revealGroup}>
      <SectionHeading title={title} lead={lead} />

      <div
        role="tablist"
        aria-label={tablistAriaLabel}
        className="mb-3 flex flex-wrap gap-2"
        {...revealSm}
      >
        {tabs.map((tab, index) => {
          const selected = index === active;
          return (
            <button
              key={tab.key}
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
        {note}
      </p>
    </section>
  );
}
