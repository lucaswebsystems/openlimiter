import { WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { ScrollReveal } from "@/components/scroll-reveal";

export function Limitations() {
  return (
    <section className="section limitations-section" aria-labelledby="limitations-title">
      <ScrollReveal className="narrow-container">
        <article className="limitations-card" data-reveal-item>
          <WarningCircle size={28} weight="regular" aria-hidden="true" />
          <div>
            <p className="eyebrow">Honest limitations</p>
            <h2 id="limitations-title" className="section-title">
              Know exactly what you get
            </h2>
            <p>
              Most providers expose no official consumer quota API, so several
              connectors read unofficial interfaces that can change without
              notice. OpenLimiter fails safe to unknown, never invents a zero,
              and never mutates provider files.
            </p>
            <p>
              OpenLimiter provides advice. It does not perform automatic routing
              today.
            </p>
            <p>
              The current source includes connector parsers and synthetic
              fixtures. Live provider fetching is not wired yet.
            </p>
          </div>
        </article>
      </ScrollReveal>
    </section>
  );
}
