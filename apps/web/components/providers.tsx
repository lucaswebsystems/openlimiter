import { ScrollReveal } from "./scroll-reveal";

export function Providers() {
  const providersList = [
    {
      name: "Claude",
      badge: "native payload",
      description:
        "Reads OAuth session state and rate limit headers from active Anthropic CLI installations.",
    },
    {
      name: "OpenRouter",
      badge: "documented API",
      description:
        "Queries key credit balance and usage windows via public management endpoints.",
    },
    {
      name: "Codex",
      badge: "internal endpoint, may break",
      description:
        "Extracts local environment authentication tokens to query session rate limit headers.",
    },
    {
      name: "Antigravity",
      badge: "internal endpoint, may break",
      description:
        "Reads local CLI token store and internal telemetry headers for active quota thresholds.",
    },
    {
      name: "OpenCode",
      badge: "session based, may break",
      description:
        "Parses active local session workspace stores for model token usage limits.",
    },
    {
      name: "Manual",
      badge: "user entered",
      description:
        "Static budget definitions for self hosted models or custom provider configurations.",
    },
  ];

  return (
    <section id="providers" className="py-20 px-4 sm:px-6 lg:px-8 border-t border-hairline">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="mb-12">
            <h2 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
              Providers
            </h2>
            <p className="mt-2 font-sans text-sm text-body">
              Honest integration statuses across supported AI services.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {providersList.map((item, idx) => (
            <ScrollReveal key={item.name} delay={idx * 0.05}>
              <div className="h-full rounded-xl border border-hairline bg-surface/40 p-5 transition-colors hover:border-hairline-strong hover:bg-surface/70 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-3">
                    <h3 className="font-sans text-lg font-medium text-heading">
                      {item.name}
                    </h3>
                    <span className="rounded border border-hairline bg-canvas px-2 py-0.5 font-mono text-[10px] font-medium text-accent">
                      {item.badge}
                    </span>
                  </div>
                  <p className="font-sans text-xs text-body leading-relaxed">
                    {item.description}
                  </p>
                </div>
              </div>
            </ScrollReveal>
          ))}

          {/* Ghost Card: More Coming */}
          <ScrollReveal delay={0.35}>
            <div className="h-full rounded-xl border border-dashed border-hairline bg-surface/20 p-5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h3 className="font-sans text-lg font-medium text-label">
                    More coming
                  </h3>
                  <span className="rounded border border-hairline bg-canvas px-2 py-0.5 font-mono text-[10px] font-medium text-label">
                    planned
                  </span>
                </div>
                <p className="font-sans text-xs text-label leading-relaxed">
                  Connectors planned for Cursor, Copilot, Devin, Grok, and Z.ai.
                </p>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}
