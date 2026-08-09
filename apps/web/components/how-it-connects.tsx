import type { ReactNode } from "react";
import { BrandMark } from "./brand";
import { ScrollReveal } from "./scroll-reveal";
import { Chip, Section, SectionHeading } from "./ui";

/**
 * How the pieces connect.
 *
 * The top band is the pipeline that exists today, and every claim in it maps
 * to a command in packages/cli. The bottom band is the roadmap, drawn dashed,
 * labelled planned in the badge and in the prose, and deliberately shown as
 * empty outlines rather than a picture of an application nobody can install.
 */

function Node({
  title,
  detail,
  status,
  icon,
}: {
  title: string;
  detail: string;
  status: "now" | "planned";
  icon?: ReactNode;
}) {
  const planned = status === "planned";

  return (
    <div
      className={`flex flex-col rounded-xl border p-5 ${
        planned
          ? "border-dashed border-hairline-strong bg-canvas"
          : "border-hairline bg-surface"
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {icon}
          <h3 className="font-sans text-sm font-medium text-heading">{title}</h3>
        </div>
        <Chip tone={planned ? "neutral" : "accent"} className="flex-none whitespace-nowrap">
          {planned ? "planned" : "available now"}
        </Chip>
      </div>
      <p className="font-sans text-sm leading-relaxed text-body">{detail}</p>
    </div>
  );
}

/**
 * The line between two nodes. It runs down the page on a narrow screen and
 * across it on a wide one, so the same markup carries both directions.
 */
function Rail() {
  return (
    <div aria-hidden="true" className="flex flex-col items-center py-3 lg:flex-row lg:py-0">
      <span className="h-6 w-0 border-l border-hairline-strong lg:h-0 lg:w-full lg:border-l-0 lg:border-t" />
      <svg
        viewBox="0 0 12 12"
        className="h-3 w-3 rotate-90 text-hairline-strong lg:rotate-0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      >
        <path d="M1 6h9M6.6 2.6 10 6l-3.4 3.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function HowItConnects() {
  return (
    <Section id="how-it-connects">
      <ScrollReveal>
        <SectionHeading
          eyebrow="How it connects"
          title="One local pipeline, and an honest line around what exists."
          lead="Everything in the top band ships today and can be run from a clone in this repository. Everything in the bottom band is written down and nothing more."
        />
      </ScrollReveal>

      <ScrollReveal step={2}>
        <div className="mt-12">
          <p className="mb-4 font-mono text-2xs uppercase tracking-widest text-muted">
            Available now
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_3.5rem_1.1fr_3.5rem_1fr] lg:items-center">
            <Node
              status="now"
              title="Data already on your machine"
              detail="Claude Code writes a session payload to your statusline command. A manual document on disk, or any script at all through the ingest command, can hand over meters the same way."
            />
            <Rail />
            <Node
              status="now"
              title="OpenLimiter CLI"
              icon={<BrandMark className="h-5 w-5 flex-none text-accent-solid" />}
              detail="Six connectors parse the shapes they know. The core validates bounds, merges one atomic cache under one lock, and derives freshness. No connector contacts a provider in this release."
            />
            <Rail />
            <div className="flex flex-col gap-4">
              <Node
                status="now"
                title="Your statusline"
                detail="One line, the worst meter per provider, a reason code in front. It falls back to the cache and never blocks the tool that called it."
              />
              <Node
                status="now"
                title="Your agent's context"
                detail="A bounded block of enum codes, numbers and timestamps on prompt submit. When every provider is unknown it injects nothing at all."
              />
            </div>
          </div>
        </div>
      </ScrollReveal>

      <ScrollReveal step={4}>
        <div className="mt-4">
          <div aria-hidden="true" className="flex justify-center py-2">
            <span className="h-8 w-0 border-l border-dashed border-hairline-strong" />
          </div>
          <p className="mb-4 font-mono text-2xs uppercase tracking-widest text-muted">
            Planned, reading the same local cache. Not built.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Node
              status="planned"
              title="Desktop tray"
              detail="An icon next to the system clock on Windows, macOS and Linux, reading the cache the CLI already writes. There is no download, and no screenshot of it exists because it does not exist."
            />
            <Node
              status="planned"
              title="Mobile applications"
              detail="iOS and Android, so a long window can be checked away from the desk. Nothing has been submitted to any store and there is no waiting list."
            />
          </div>
        </div>
      </ScrollReveal>
    </Section>
  );
}
