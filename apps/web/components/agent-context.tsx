import type { ReactNode } from "react";
import { CliTranscript } from "./cli-transcript";
import { CodeChip, IconChip, SectionHeading } from "./ui";
import { CAPTURED_ON, hookCapture } from "@/lib/cli-capture";
import { reveal } from "@/lib/motion";

/**
 * How the agent context is bounded.
 *
 * The panel on the left is the exact block a coding agent receives, printed
 * verbatim from the capture, and it is the only code block on this section.
 * The four notes on the right are the reasons that block looks the way it does,
 * and each leads with a glyph rather than opening on a bare line of text. There
 * is no claim of automatic routing anywhere on this section, because there is
 * none in the product.
 */

function ShieldGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.75l7.25 2.6v5.4c0 4.35-2.95 8.1-7.25 9.5-4.3-1.4-7.25-5.15-7.25-9.5v-5.4Z" />
      <path d="m9 12 2.1 2.1L15.2 10" />
    </svg>
  );
}

function EnumGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6.5h3M4 12h3M4 17.5h3" />
      <path d="M10.5 6.5H20M10.5 12H20M10.5 17.5H20" />
    </svg>
  );
}

function SilenceGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9.25" />
      <path d="M8 12h8" />
    </svg>
  );
}

function CompassGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9.25" />
      <path d="m15.4 8.6-2 4.8-4.8 2 2-4.8Z" />
    </svg>
  );
}

const guarantees: readonly { title: string; detail: string; Glyph: () => ReactNode }[] = [
  {
    title: "Provider text never crosses",
    Glyph: ShieldGlyph,
    detail:
      "Parsers keep known numbers and known timestamps. Labels, messages, account text, markup and unknown fields are discarded before anything reaches policy code, so no provider's prose can become an instruction to your agent.",
  },
  {
    title: "Enum codes only",
    Glyph: EnumGlyph,
    detail:
      "The advice engine emits provider codes, reason codes, bounded percentages, freshness codes and timestamps. The adapter validates every one of them again on the way out.",
  },
  {
    title: "Silence beats a guess",
    Glyph: SilenceGlyph,
    detail:
      "If every provider is unknown, the hook injects nothing at all. It reads the local cache, makes no network request, and exits 0 whatever happens.",
  },
  {
    title: "Advice, not routing",
    Glyph: CompassGlyph,
    detail:
      "OpenLimiter tells your agent what is left and what that suggests. It does not switch providers for you, does not bypass a limit, and does not touch how anything authenticates. The decision stays yours.",
  },
];

export function AgentContext() {
  return (
    <section id="agent-context">
      <SectionHeading
        title="Read, bound, hand over"
        lead="A block injected into a prompt is an injection surface. This one carries enum codes, bounded numbers and timestamps, and it says so about itself in its own opening tag."
      />

      <div
        className="elev-1 relative overflow-hidden rounded-2xl border border-hairline bg-surface"
        {...reveal}
      >
        <span aria-hidden="true" className="hairline-sheen" />
        <div className="flex flex-col gap-3 border-b border-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <CodeChip>openlimiter hook</CodeChip>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Captured {CAPTURED_ON}</span>
          </div>
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-[1.1fr_0.9fr] md:p-5">
          <CliTranscript capture={hookCapture} />
          <div className="grid min-w-0 gap-3 sm:grid-cols-2 md:grid-cols-1">
            {guarantees.map(({ title, detail, Glyph }) => (
              <div
                key={title}
                className="lift elev-1 flex gap-3.5 rounded-xl border border-hairline bg-canvas px-4 py-3.5 hover:border-hairline-strong hover:bg-raised"
              >
                <IconChip>
                  <Glyph />
                </IconChip>
                <div className="min-w-0">
                  <p className="heading-face text-sm text-heading">{title}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
