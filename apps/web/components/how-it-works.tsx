import {
  ArrowsClockwise,
  Database,
  Signpost,
} from "@phosphor-icons/react/dist/ssr";
import { ScrollReveal } from "@/components/scroll-reveal";
import { IconChip, SectionIntro } from "@/components/ui";

const steps = [
  {
    icon: Database,
    number: "01",
    title: "Read",
    body: "Detect installed AI tools and parse quota data locally. Current source accepts caller supplied payloads while live fetching remains unwired.",
  },
  {
    icon: ArrowsClockwise,
    number: "02",
    title: "Normalize",
    body: "Create one freshness aware snapshot. Unknown data never becomes a fake zero.",
  },
  {
    icon: Signpost,
    number: "03",
    title: "Advise",
    body: "Render a statusline for you and bounded context for your agents. The choice stays with the agent.",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="section" aria-labelledby="how-title">
      <ScrollReveal className="content-container">
        <div data-reveal-item>
          <SectionIntro
            eyebrow="A small local loop"
            title="Three steps to quota awareness"
          >
            <p>Read what is available, make it comparable, then surface careful advice.</p>
          </SectionIntro>
        </div>

        <div className="card-grid card-grid-three">
          {steps.map((step) => (
            <article key={step.title} className="feature-card" data-reveal-item>
              <div className="card-topline">
                <IconChip icon={step.icon} />
                <span className="step-number">{step.number}</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          ))}
        </div>
      </ScrollReveal>
    </section>
  );
}
