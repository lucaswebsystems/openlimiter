import { ScrollReveal } from "./scroll-reveal";
import { ButtonLink, Chip, Section, SectionHeading } from "./ui";

/**
 * Roadmap.
 *
 * Every entry here is labelled planned, in the badge and in the prose, because
 * none of it exists. Nothing on this list can be downloaded or bought.
 */
const planned = [
  {
    title: "Desktop application",
    detail:
      "A tray icon next to the system clock on Windows, macOS, and Linux, reading the same local cache the CLI already writes.",
  },
  {
    title: "Mobile applications",
    detail:
      "Applications for iOS and Android, so a long running window can be checked away from the desk. Nothing is submitted to any store.",
  },
  {
    title: "Encrypted synchronisation",
    detail:
      "Quota state shared across your own devices, encrypted. The CLI would keep working with no account and no network either way.",
  },
];

export function Roadmap() {
  return (
    <Section id="roadmap">
      <ScrollReveal>
        <SectionHeading
          eyebrow="Roadmap"
          title="Planned, and honestly not built yet."
          lead="These three are written down so the direction is clear. None of them exists today, none can be installed, and none is on a waitlist."
        />
      </ScrollReveal>

      <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
        {planned.map((item, index) => (
          <ScrollReveal key={item.title} step={index * 2}>
            <div className="h-full rounded-xl border border-dashed border-hairline-strong bg-canvas p-6">
              <div className="mb-3 flex items-start justify-between gap-3">
                <h3 className="font-sans text-base font-medium text-heading">{item.title}</h3>
                <Chip tone="neutral">planned</Chip>
              </div>
              <p className="font-sans text-sm leading-relaxed text-body">{item.detail}</p>
            </div>
          </ScrollReveal>
        ))}
      </div>

      <ScrollReveal step={6}>
        <div className="mt-6">
          <ButtonLink href="/docs/roadmap" tone="secondary">
            What planned means here
          </ButtonLink>
        </div>
      </ScrollReveal>
    </Section>
  );
}
