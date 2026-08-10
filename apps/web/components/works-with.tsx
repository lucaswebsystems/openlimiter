import Link from "next/link";
import { MANUAL_TODAY_NOTE, plannedTools, todayTools, type Tool } from "./tool-marks";
import { Chip, IconChip, SectionHeading } from "./ui";
import { reveal, revealGroup, revealSm } from "@/lib/motion";

/**
 * The agent grid.
 *
 * Two groups, and the line between them is the point of the section. The first
 * group is the six connectors that ship in this release, each one carrying a
 * `today` chip. The second is twelve well known tools with no connector, each
 * one carrying a `planned` chip, so the grid can be as wide as the field
 * without a single tile implying support that does not exist.
 *
 * The note between them is what keeps the planned group honest rather than a
 * tease: every name on this page can be metered today by hand, through manual
 * entry or through the generic ingest command, and that is written out rather
 * than hinted at.
 *
 * Marks come from components/tool-marks.tsx, which reproduces real brand
 * artwork from Simple Icons in `currentColor`. Nothing here is a brand colour
 * and nothing is fetched.
 */

function ToolTile({ tool }: { tool: Tool }) {
  const planned = tool.state === "planned";
  return (
    <div
      className={`lift elev-1 flex items-center gap-3 rounded-xl border px-4 py-3.5 ${
        planned
          ? "border-hairline bg-canvas hover:border-hairline-strong hover:bg-surface"
          : "border-hairline bg-surface hover:border-hairline-strong hover:bg-raised"
      }`}
      {...reveal}
    >
      <IconChip tone={planned ? "neutral" : "accent"}>
        <tool.Mark className="h-5 w-5" />
      </IconChip>
      <span className="min-w-0 flex-1">
        <span className="heading-face block truncate text-sm text-heading">{tool.name}</span>
        <span className="mt-0.5 block text-xs text-muted">
          {planned ? "No connector yet" : "Connector"}
        </span>
      </span>
      <Chip tone={planned ? "neutral" : "accent"} dot={!planned} className="flex-none">
        {planned ? "planned" : "today"}
      </Chip>
    </div>
  );
}

function GroupLabel({ title, note }: { title: string; note: string }) {
  return (
    /* Below the small breakpoint the note takes a line of its own and the rule
       goes away, so a short label and a long one wrap the same way instead of
       one of them squeezing the rule down to a stub. */
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1" {...revealSm}>
      <h3 className="font-mono text-2xs uppercase tracking-widest text-heading">{title}</h3>
      <span aria-hidden="true" className="hidden h-px flex-1 bg-hairline sm:block" />
      <p className="w-full text-xs text-muted sm:w-auto">{note}</p>
    </div>
  );
}

export function WorksWith() {
  return (
    <section id="providers">
      <SectionHeading
        title="Works with your tools"
        lead="One meter over every subscription you already hold. Each connector reads a shape that something on your machine already wrote, and in this release not one of them touches the network."
      />

      <GroupLabel title="Connected today" note="Six connectors ship in this release" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" {...revealGroup}>
        {todayTools.map((tool) => (
          <ToolTile key={tool.name} tool={tool} />
        ))}
      </div>

      <div className="mt-10">
        <GroupLabel title="Planned" note="Known, named, and not written yet" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" {...revealGroup}>
          {plannedTools.map((tool) => (
            <ToolTile key={tool.name} tool={tool} />
          ))}
        </div>
      </div>

      <div
        className="lift elev-1 mt-6 flex flex-col gap-4 rounded-xl border border-accent-subtle bg-accent-subtle px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
        {...reveal}
      >
        <p className="max-w-2xl text-sm leading-relaxed text-accent">{MANUAL_TODAY_NOTE}</p>
        <Link
          href="/docs/ingestion"
          className="focus-ring inline-flex flex-none items-center gap-1.5 rounded text-sm font-medium text-accent hover:text-accent-hover"
        >
          How to feed one in
          <span aria-hidden="true">&rarr;</span>
        </Link>
      </div>

      <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted" {...reveal}>
        Every connector ships marked{" "}
        <span className="font-mono text-2xs text-heading">UNVERIFIED</span>, which is the honest
        default: no explicit verifier has confirmed a shape against a live account yet. Three of
        them read interfaces that are internal to somebody else&apos;s tooling and can change without
        notice, and when one does, that provider fails closed to unknown rather than guessing.{" "}
        <Link
          href="/docs/providers"
          className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
        >
          Every connector and its real state
        </Link>
        .
      </p>
    </section>
  );
}
