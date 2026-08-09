"use client";

import { Check, Copy, GithubLogo } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { links } from "@/components/links";
import { ScrollReveal } from "@/components/scroll-reveal";

const installCommand = "npm install -g openlimiter";

export function FinalCta() {
  const [copied, setCopied] = useState(false);
  const reduceMotion = Boolean(useReducedMotion());

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="section final-cta-section" aria-labelledby="final-title">
      <ScrollReveal className="content-container final-cta">
        <div className="final-glow" aria-hidden="true" />
        <div data-reveal-item>
          <p className="eyebrow">Ready at launch</p>
          <h2 id="final-title">Give your agents budget sense.</h2>
          <p>
            Follow the source today. Install the local CLI when the first public
            release lands.
          </p>
        </div>

        <div className="final-actions" data-reveal-item>
          <motion.a
            href={links.github}
            target="_blank"
            rel="noreferrer"
            className="button button-primary"
            whileHover={reduceMotion ? undefined : { y: -2 }}
            whileTap={reduceMotion ? undefined : { scale: 0.98 }}
          >
            <GithubLogo size={20} weight="regular" aria-hidden="true" />
            Star on GitHub
          </motion.a>

          <div className="install-wrap">
            <span className="launch-label">available at launch</span>
            <button
              type="button"
              className="install-chip"
              onClick={copyCommand}
              aria-label="Copy install command"
            >
              <code>{installCommand}</code>
              {copied ? (
                <Check size={19} weight="regular" aria-hidden="true" />
              ) : (
                <Copy size={19} weight="regular" aria-hidden="true" />
              )}
            </button>
            <span className="sr-only" aria-live="polite">
              {copied ? "Install command copied" : ""}
            </span>
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}
