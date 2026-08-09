import { ScrollReveal } from "./scroll-reveal";
import { Section, SectionHeading } from "./ui";

const steps = [
  {
    title: "Read",
    summary: "Parsers over data that already exists on your machine",
    detail:
      "Six connectors translate a known shape into raw meters. They perform no network access in this release, and they never rewrite the files they read.",
  },
  {
    title: "Normalise",
    summary: "One snapshot schema, freshness derived, unknown left as unknown",
    detail:
      "Closed enums, bounded percentages, and validated timestamps. A row that fails validation is dropped and the rest still count. A missing reading never becomes a fabricated zero.",
  },
  {
    title: "Advise",
    summary: "A statusline for you, a bounded context block for your agent",
    detail:
      "The advice engine emits enum codes, numbers, and timestamps only. Your agent sees the state of your budget and a reason code. It never sees provider text.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works">
      <ScrollReveal>
        <SectionHeading
          eyebrow="How it works"
          title="Three quiet steps from local files to agent awareness."
          lead="Nothing leaves your machine at any point in this pipeline."
        />
      </ScrollReveal>

      <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
        {steps.map((step, index) => (
          <ScrollReveal key={step.title} step={index * 2}>
            <div className="h-full rounded-xl border border-hairline bg-surface p-6 transition-colors hover:border-hairline-strong hover:bg-raised">
              <p className="font-mono text-2xs text-accent">0{index + 1}</p>
              <h3 className="mt-4 font-sans text-lg font-medium tracking-tight text-heading">
                {step.title}
              </h3>
              <p className="mt-2 font-sans text-sm font-medium leading-snug text-heading">
                {step.summary}
              </p>
              <p className="mt-3 font-sans text-sm leading-relaxed text-body">{step.detail}</p>
            </div>
          </ScrollReveal>
        ))}
      </div>
    </Section>
  );
}
