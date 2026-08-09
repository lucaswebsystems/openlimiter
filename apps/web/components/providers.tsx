import { ScrollReveal } from "./scroll-reveal";
import { Chip, Section, SectionHeading } from "./ui";

const providers = [
  {
    name: "Claude",
    badge: "native payload",
    reads: "the Claude Code statusline payload",
    detail:
      "Reads the rate limit block Claude Code already hands to your statusline command. It asks nothing of Anthropic on its own.",
  },
  {
    name: "OpenRouter",
    badge: "documented API",
    reads: "a documented credits response",
    detail:
      "Parses the credits shape OpenRouter documents. The key it would use belongs in your operating system credential store, never in a file.",
  },
  {
    name: "Codex",
    badge: "internal, may break",
    reads: "a Codex usage payload",
    detail:
      "Parses the usage shape the Codex tooling produces. The shape is internal, so it can change without notice.",
  },
  {
    name: "Antigravity",
    badge: "internal, may break",
    reads: "an Antigravity quota payload",
    detail:
      "Parses the quota shape the Antigravity tooling produces. The shape is internal, so it can change without notice.",
  },
  {
    name: "OpenCode",
    badge: "session based, may break",
    reads: "a session you already signed in to",
    detail:
      "Describes the usage view behind an existing session. It carries the highest automation risk of the six and stops the moment that session expires.",
  },
  {
    name: "Manual",
    badge: "user entered",
    reads: "numbers you write yourself",
    detail:
      "Budgets you maintain by hand, for a self hosted model or any subscription without a connector. It never breaks and never guesses.",
  },
];

export function Providers() {
  return (
    <Section id="providers">
      <ScrollReveal>
        <SectionHeading
          eyebrow="Providers"
          title="Six connectors, each labelled with how much to trust it."
          lead="There is no OpenLimiter server in this picture. A connector reads something already sitting on your machine, and in this release not one of them touches the network."
        />
      </ScrollReveal>

      <div className="mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((provider, index) => (
          <ScrollReveal key={provider.name} step={index}>
            <div className="flex h-full flex-col justify-between rounded-xl border border-hairline bg-surface p-5 transition-colors hover:border-hairline-strong hover:bg-raised">
              <div>
                <div className="mb-3 flex items-start justify-between gap-3">
                  <h3 className="font-sans text-base font-medium text-heading">{provider.name}</h3>
                  <Chip tone="accent">{provider.badge}</Chip>
                </div>
                <p className="font-sans text-sm leading-relaxed text-body">{provider.detail}</p>
              </div>
              <p className="mt-4 flex flex-wrap items-baseline gap-x-2 border-t border-hairline pt-3 font-mono text-2xs">
                <span className="uppercase tracking-widest text-muted">reads</span>
                <span className="text-body">{provider.reads}</span>
              </p>
            </div>
          </ScrollReveal>
        ))}
      </div>

      <ScrollReveal step={7}>
        <p className="mt-6 font-sans text-sm text-body">
          Every connector ships marked{" "}
          <span className="font-mono text-2xs text-heading">UNVERIFIED</span>, which is the honest
          default: no explicit verifier has confirmed a shape against a live account yet.
        </p>
      </ScrollReveal>
    </Section>
  );
}
