import { CliTranscript } from "./cli-transcript";
import { DemoDataChip, SectionHeading } from "./ui";
import { CAPTURED_ON, hookCapture } from "@/lib/cli-capture";
import { reveal } from "@/lib/motion";

/**
 * How the agent context is bounded.
 *
 * The panel on the left is the exact block a coding agent receives, printed
 * verbatim from the capture. The three notes on the right are the reasons that
 * block looks the way it does. There is no claim of automatic routing anywhere
 * on this section, because there is none in the product.
 */

const guarantees = [
  {
    title: "Provider text never crosses",
    detail:
      "Parsers keep known numbers and known timestamps. Labels, messages, account text, markup and unknown fields are discarded before anything reaches policy code, so no provider's prose can become an instruction to your agent.",
  },
  {
    title: "Enum codes only",
    detail:
      "The advice engine emits provider codes, reason codes, bounded percentages, freshness codes and timestamps. The adapter validates every one of them again on the way out.",
  },
  {
    title: "Silence beats a guess",
    detail:
      "If every provider is unknown, the hook injects nothing at all. It reads the local cache, makes no network request, and exits 0 whatever happens.",
  },
  {
    title: "Advice, not routing",
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

      <div className="overflow-hidden rounded-2xl border border-hairline bg-surface" {...reveal}>
        <div className="flex flex-col gap-3 border-b border-hairline px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-2xs text-muted">openlimiter hook</span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>Captured {CAPTURED_ON}</span>
            <DemoDataChip />
          </div>
        </div>

        <div className="grid gap-4 p-4 md:grid-cols-[1.1fr_0.9fr]">
          <CliTranscript capture={hookCapture} />
          <div className="min-w-0 space-y-4">
            {guarantees.map((item) => (
              <div
                key={item.title}
                className="lift rounded-xl border border-hairline bg-canvas px-4 py-3 hover:border-hairline-strong hover:bg-raised"
              >
                <p className="text-sm font-medium text-heading">{item.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
