"use client";

import { useId, useState } from "react";
import { ScrollReveal } from "./scroll-reveal";
import { SectionHeading } from "./ui";

const faqItems = [
  {
    question: "What actually leaves my machine?",
    answer:
      "Nothing. There is no telemetry, no analytics, and no OpenLimiter server to receive anything. This release performs no provider egress at all: every connector is a parser over data that something else already wrote to your disk or piped to standard input.",
  },
  {
    question: "Is it safe to point at my tools?",
    answer:
      "OpenLimiter opens what your installed tools already store, read only, and never rewrites, repairs, or migrates them. Every parser keeps bounded numbers and timestamps and discards provider text before anything reaches your agent.",
  },
  {
    question: "Can the prompt hook break my session?",
    answer:
      "No. The hook reads the local cache, makes no network request, injects nothing when every provider is unknown, and exits 0 whatever happens. The statusline behaves the same way: if input is absent or malformed it falls back to the cache and reports unknown.",
  },
  {
    question: "Which providers work today?",
    answer:
      "Six connectors ship: Claude through the native statusline payload, OpenRouter through its documented shape, Codex and Antigravity through internal shapes that may break, OpenCode through an existing session that may break, and manual entry. Every one is marked UNVERIFIED until an explicit verifier exists.",
  },
  {
    question: "Do I need an API key?",
    answer:
      "Not to start. The Claude path reads a payload Claude Code already hands your statusline, and the manual path needs nothing at all. OpenRouter is the one connector that expects a key of your own, and that key belongs in your operating system credential store.",
  },
  {
    question: "Does it route my requests for me?",
    answer:
      "No, and it is not going to. OpenLimiter provides advice. It does not route requests automatically, does not bypass a limit, and does not touch how your agent authenticates. The decision stays with you.",
  },
  {
    question: "What happens when a connector breaks?",
    answer:
      "Unofficial shapes change without notice. When one does, parsing fails closed: that provider returns to unknown, the other providers are unaffected, and nothing invents a number to fill the gap. Unknown never becomes zero.",
  },
  {
    question: "What is the paid plan for?",
    answer:
      "Everything that runs locally is free and always will be. The only thing that would ever cost money is a hosted service, namely encrypted synchronisation, mobile access, and push alerts, because servers cost money to run. It does not exist yet, there is no checkout, and no feature has been withheld to create it.",
  },
];

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const baseId = useId();

  return (
    <section id="faq" className="border-t border-hairline px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <ScrollReveal>
          <SectionHeading
            eyebrow="Questions"
            title="Frequently asked questions"
            lead="Safety, privacy, scope, and what is honestly not built yet."
          />
        </ScrollReveal>

        <div className="mt-10 space-y-3">
          {faqItems.map((item, index) => {
            const isOpen = openIndex === index;
            const triggerId = `${baseId}-trigger-${index}`;
            const panelId = `${baseId}-panel-${index}`;
            return (
              <ScrollReveal key={item.question} step={index}>
                <div className="overflow-hidden rounded-xl border border-hairline bg-surface transition-colors hover:border-hairline-strong">
                  <h3 className="font-sans text-sm font-medium">
                    <button
                      type="button"
                      id={triggerId}
                      aria-controls={panelId}
                      aria-expanded={isOpen}
                      onClick={() => setOpenIndex(isOpen ? null : index)}
                      className="focus-ring-inset flex w-full items-center justify-between gap-4 rounded-xl p-5 text-left text-heading"
                    >
                      <span>{item.question}</span>
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        strokeWidth="1.8"
                        className={`h-4 w-4 flex-none stroke-current text-muted transition-transform ${
                          isOpen ? "rotate-180" : ""
                        }`}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  </h3>
                  <div
                    id={panelId}
                    role="region"
                    aria-labelledby={triggerId}
                    hidden={!isOpen}
                    className="border-t border-hairline px-5 pb-5 pt-4 font-sans text-sm leading-relaxed text-body"
                  >
                    {item.answer}
                  </div>
                </div>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
