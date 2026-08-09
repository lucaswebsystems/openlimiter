import { BracketsCurly } from "@phosphor-icons/react/dist/ssr";
import { ScrollReveal } from "@/components/scroll-reveal";
import { DemoChip, IconChip } from "@/components/ui";

export function Wedge() {
  return (
    <section className="section" aria-labelledby="wedge-title">
      <ScrollReveal className="content-container split-grid">
        <div data-reveal-item>
          <IconChip icon={BracketsCurly} />
          <p className="eyebrow">The missing context</p>
          <h2 id="wedge-title" className="section-title">
            Your dashboards talk to you. Nobody talks to your agents.
          </h2>
          <p className="section-copy">
            Coding agents burn quota without knowing what remains. OpenLimiter
            injects bounded budget state and routing advice into the context they
            already read, so they can make informed choices without exposing raw
            provider responses.
          </p>
        </div>

        <div className="code-window" data-reveal-item>
          <div className="code-window-bar">
            <span>agent context</span>
            <DemoChip />
          </div>
          <pre aria-label="Synthetic injected context example">
            <code>
              <span className="code-label">OPENLIMITER_CONTEXT</span>{"\n"}
              {"{"}{"\n"}
              {"  "}<span className="code-key">freshness</span>: <span className="code-value">FRESH</span>,{"\n"}
              {"  "}<span className="code-key">claude</span>: <span className="code-value">AVAILABLE</span>,{"\n"}
              {"  "}<span className="code-key">codex</span>: <span className="code-warn">NEAR_CAP</span>,{"\n"}
              {"  "}<span className="code-key">gemini</span>: <span className="code-muted">UNKNOWN</span>,{"\n"}
              {"  "}<span className="code-key">advice</span>: <span className="code-string">&quot;PREFER_CLAUDE&quot;</span>{"\n"}
              {"}"}
            </code>
          </pre>
          <p className="code-note">Bounded enums. No credentials. Advice only.</p>
        </div>
      </ScrollReveal>
    </section>
  );
}
