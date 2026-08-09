"use client";

import { useState } from "react";
import { ScrollReveal } from "./scroll-reveal";

export function FinalCta() {
  const [copied, setCopied] = useState(false);
  const commandText = "npm install -g openlimiter";

  const handleCopy = () => {
    navigator.clipboard.writeText(commandText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="py-24 px-4 sm:px-6 lg:px-8 border-t border-hairline">
      <div className="mx-auto max-w-4xl text-center">
        <ScrollReveal>
          <h2 className="font-sans text-3xl font-medium tracking-tight text-heading sm:text-4xl">
            Give your agents budget sense.
          </h2>
          <p className="mt-3 font-sans text-sm text-body">
            Local first quota awareness for the agent tools you already run.
          </p>

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://github.com/lucaswebsystems/openlimiter"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-btn-primary-bg px-6 py-3 font-sans text-xs font-semibold text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
            >
              <svg
                className="h-4 w-4 fill-current"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              Star on GitHub
            </a>

            {/* Install Command Chip */}
            <div className="flex items-center rounded-lg border border-hairline bg-surface/70 px-4 py-2.5 font-mono text-xs text-heading">
              <span className="text-body mr-2">$</span>
              <span>{commandText}</span>
              <button
                type="button"
                onClick={handleCopy}
                className="focus-ring ml-3 rounded border border-hairline bg-canvas px-2 py-0.5 text-[10px] text-label transition-colors hover:text-heading"
                aria-label="Copy install command"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>

          <div className="mt-4 font-mono text-[11px] text-label">
            available at launch
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
