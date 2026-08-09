"use client";

import { useState } from "react";
import { ScrollReveal } from "./scroll-reveal";

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const faqItems = [
    {
      question: "Is it safe?",
      answer:
        "Yes. OpenLimiter runs entirely on your local machine. It reads local credentials and session tokens stored by your installed CLI tools to fetch quota states directly.",
    },
    {
      question: "What leaves my machine?",
      answer:
        "Nothing. Zero telemetry, zero external tracking, zero cloud dependencies. Your quota data stays on your machine.",
    },
    {
      question: "Which agents are supported?",
      answer:
        "Claude Code is supported first class. Codex CLI and OpenCode integration follow closely.",
    },
    {
      question: "Does it need an API key?",
      answer:
        "No API keys are required for auto detected tools. OpenLimiter reads existing local session state or accepts manual configuration.",
    },
    {
      question: "When is Pro coming?",
      answer:
        "Pro encrypted sync and alert features are currently in development. You can track progress or join the waitlist on GitHub issues.",
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
            return (
              <ScrollReveal key={item.question} delay={idx * 0.05}>
                <div className="rounded-xl border border-hairline bg-surface/40 overflow-hidden transition-colors hover:border-hairline-strong">
                  <button
                    type="button"
                    onClick={() => setOpenIndex(isOpen ? null : idx)}
                    className="flex w-full items-center justify-between p-5 text-left font-sans text-sm font-medium text-heading focus:outline-none"
                    aria-expanded={isOpen}
                  >
                    <span>{item.question}</span>
                    <span className="ml-4 flex h-5 w-5 flex-shrink-0 items-center justify-center text-label">
                      {isOpen ? "−" : "+"}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-5 pt-1 font-sans text-xs text-body leading-relaxed border-t border-hairline/40">
                      {item.answer}
                    </div>
                  )}
                </div>
              </ScrollReveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}
