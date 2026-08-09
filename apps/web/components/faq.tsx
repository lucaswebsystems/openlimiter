import { ScrollReveal } from "@/components/scroll-reveal";
import { SectionIntro } from "@/components/ui";

const questions = [
  {
    question: "Is OpenLimiter safe?",
    answer:
      "OpenLimiter is designed for read only quota awareness. It never mutates provider files, bounds the context it emits, and fails safe to unknown when data is stale or malformed.",
  },
  {
    question: "What data leaves my machine?",
    answer:
      "Nothing in the free local workflow. OpenLimiter has zero telemetry. The optional Pro service will explain its encrypted sync model before launch.",
  },
  {
    question: "Which agents are supported?",
    answer:
      "Claude Code comes first through a statusline and prompt hook. Codex CLI and OpenCode adapters are planned next.",
  },
  {
    question: "Does it work without any API key?",
    answer:
      "The launch design supports detected tools and manual mode without an OpenLimiter API key. Current source accepts caller supplied payloads while live fetching remains unwired.",
  },
  {
    question: "When is Pro coming?",
    answer:
      "Pro is coming soon. There is no checkout today. Follow the GitHub issues page for milestones and waitlist updates.",
  },
] as const;

export function Faq() {
  return (
    <section id="faq" className="section section-tinted" aria-labelledby="faq-title">
      <ScrollReveal className="content-container faq-grid">
        <div data-reveal-item>
          <SectionIntro eyebrow="Clear answers" title="Questions, answered">
            <p>No fine print. The local tool stays open source and transparent.</p>
          </SectionIntro>
        </div>

        <div className="faq-list" data-reveal-item>
          {questions.map((item) => (
            <details key={item.question}>
              <summary>
                <span>{item.question}</span>
                <span className="faq-marker" aria-hidden="true">+</span>
              </summary>
              <p>{item.answer}</p>
            </details>
          ))}
        </div>
      </ScrollReveal>
    </section>
  );
}
