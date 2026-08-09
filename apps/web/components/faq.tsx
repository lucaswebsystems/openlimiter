"use client";

import { useId, useState } from "react";
import { ScrollReveal } from "./scroll-reveal";

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const baseId = useId();

  const faqItems = [
    {
      question: "Is it safe?",
      answer:
        "OpenLimiter reads what your installed tools already store on your machine: local session state, quota files the provider CLIs write themselves, and any key you chose to add. It opens them read only and never rewrites, repairs, or migrates them. Every parser keeps bounded numbers and timestamps and drops provider text before anything reaches an agent.",
    },
    {
      question: "What leaves my machine?",
      answer:
        "No telemetry, no analytics, and no OpenLimiter server, so nothing is ever sent to us. The only network requests OpenLimiter makes go to a provider's own endpoint to read your quota, using credentials that are already on your machine. Connectors that read a local file, or the payload Claude Code hands to your statusline, make no request at all.",
    },
    {
      question: "Which agents are supported?",
      answer:
        "Claude Code is supported first class. Codex CLI and OpenCode follow closely. Each connector carries its own status in the providers list above, including the ones still marked unverified.",
    },
    {
      question: "Does it need an API key?",
      answer:
        "No API keys are needed for the tools OpenLimiter can detect on its own, because it reads session state those tools already wrote. OpenRouter is the exception: it uses a key you add to your operating system credential store. You can also enter a budget by hand for anything else.",
    },
    {
      question: "When is Pro coming?",
      answer:
        "Pro encrypted sync and alerts are in development. There is no checkout and no waitlist yet, so the honest answer is to follow the work on the GitHub issue tracker.",
    },
  ];

  return (
    <section id="faq" className="py-20 px-4 sm:px-6 lg:px-8 border-t border-hairline">
      <div className="mx-auto max-w-4xl">
        <ScrollReveal>
          <div className="mb-10 text-left">
            <h2 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
              Frequently asked questions
            </h2>
            <p className="mt-2 font-sans text-sm text-body">
              Everything you need to know about safety, privacy, and roadmap.
            </p>
          </div>
        </ScrollReveal>

        <div className="space-y-3">
          {faqItems.map((item, idx) => {
            const isOpen = openIndex === idx;
            const triggerId = `${baseId}-trigger-${idx}`;
            const panelId = `${baseId}-panel-${idx}`;
            return (
              <ScrollReveal key={item.question} step={idx}>
                <div className="rounded-xl border border-hairline bg-surface/40 overflow-hidden transition-colors hover:border-hairline-strong">
                  <h3 className="font-sans text-sm font-medium">
                    <button
                      type="button"
                      id={triggerId}
                      aria-controls={panelId}
                      aria-expanded={isOpen}
                      onClick={() => setOpenIndex(isOpen ? null : idx)}
                      className="focus-ring-inset flex w-full items-center justify-between rounded-xl p-5 text-left text-heading"
                    >
                      <span>{item.question}</span>
                      <span
                        aria-hidden="true"
                        className="ml-4 flex h-5 w-5 flex-shrink-0 items-center justify-center text-label"
                      >
                        {isOpen ? "−" : "+"}
                      </span>
                    </button>
                  </h3>
                  <div
                    id={panelId}
                    role="region"
                    aria-labelledby={triggerId}
                    hidden={!isOpen}
                    className="px-5 pb-5 pt-1 font-sans text-xs text-body leading-relaxed border-t border-hairline/40"
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
