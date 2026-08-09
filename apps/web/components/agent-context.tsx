import { CliTranscript } from "./cli-transcript";
import { ScrollReveal } from "./scroll-reveal";
import { ButtonLink, DemoDataChip, Section, SectionHeading } from "./ui";
import { CAPTURED_ON, hookCapture } from "@/lib/cli-capture";

const guarantees = [
  {
    title: "Provider text never crosses",
    detail:
      "Parsers keep known numbers and known timestamps. Labels, messages, account text, markup, and unknown fields are discarded before anything reaches policy code.",
  },
  {
    title: "Enum codes only",
    detail:
      "The advice engine emits provider codes, reason codes, bounded percentages, freshness codes, and timestamps. The adapter validates every one of them again.",
  },
  {
    title: "Silence beats a guess",
    detail:
      "If every provider is unknown, the hook injects nothing at all. It reads the local cache, makes no network request, and exits 0 whatever happens.",
  },
];

export function AgentContextExample() {
  return (
    <Section id="agent-context">
      <ScrollReveal>
        <SectionHeading
          eyebrow="Agent context"
          title="Your agent gets budget state, never provider prose."
          lead="A block injected into a prompt is an injection surface. This one carries enum codes, bounded numbers, and timestamps, and it says so about itself."
        />
      </ScrollReveal>

      <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ScrollReveal step={2}>
          <div className="h-full overflow-hidden rounded-xl border border-hairline bg-surface">
            <div className="flex items-center justify-between gap-4 border-b border-hairline bg-canvas px-4 py-3">
              <span className="font-mono text-2xs text-muted">openlimiter hook</span>
              <DemoDataChip />
            </div>
            <div className="p-4">
              <CliTranscript capture={hookCapture} />
            </div>
            <p className="border-t border-hairline bg-canvas px-4 py-3 font-mono text-2xs leading-relaxed text-muted">
              Captured on {CAPTURED_ON} against the synthetic demo fixtures.
            </p>
          </div>
        </ScrollReveal>

        <ScrollReveal step={4}>
          <div className="flex h-full flex-col gap-4">
            {guarantees.map((item) => (
              <div key={item.title} className="rounded-xl border border-hairline bg-surface p-5">
                <h3 className="font-sans text-sm font-medium text-heading">{item.title}</h3>
                <p className="mt-2 font-sans text-sm leading-relaxed text-body">{item.detail}</p>
              </div>
            ))}
            <div className="mt-auto pt-2">
              <ButtonLink href="/docs/agent-context" tone="secondary">
                Read the field reference
              </ButtonLink>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </Section>
  );
}
