import { ScrollReveal } from "./scroll-reveal";

export function Providers() {
  const providersList = [
    {
      name: "Claude",
      badge: "native payload",
      origin: "local statusline payload",
      description:
        "Reads the rate limit payload Claude Code already hands to your statusline. It asks nothing of Anthropic on its own.",
    },
    {
      name: "OpenRouter",
      badge: "documented API",
      origin: "openrouter.ai",
      description:
        "Reads your credit balance and usage window from OpenRouter's documented management API, using a key you keep in your operating system credential store.",
    },
    {
      name: "Codex",
      badge: "internal endpoint, may break",
      origin: "local Codex usage file",
      description:
        "Reads the usage file the Codex CLI keeps in its own state directory. The shape is internal, so it can change without notice.",
    },
    {
      name: "Antigravity",
      badge: "internal endpoint, may break",
      origin: "local Antigravity quota file",
      description:
        "Reads the quota file the Antigravity CLI keeps in its own state directory. The shape is internal, so it can change without notice.",
    },
    {
      name: "OpenCode",
      badge: "session based, may break",
      origin: "your existing OpenCode session",
      description:
        "Reads the usage view behind a session you already signed into. Unverified, and it stops the moment that session expires.",
    },
    {
      name: "Manual",
      badge: "user entered",
      origin: "your own entries, no network",
      description:
        "Budgets you write yourself, for self hosted models or any provider without a connector yet.",
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
              Honest status for every supported connector, including what each
              one reads from.
            </p>
            <p className="mt-3 max-w-2xl font-sans text-sm text-body leading-relaxed">
              There is no OpenLimiter server in this picture. A connector either
              reads something already sitting on your machine, or calls that
              provider&apos;s own endpoint with credentials you already hold.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {providersList.map((item, idx) => (
            <ScrollReveal key={item.name} step={idx}>
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
                <div className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-hairline/60 pt-3 font-mono text-[10px]">
                  <span className="uppercase tracking-wider text-label">
                    reads
                  </span>
                  <span className="text-body">{item.origin}</span>
                </div>
              </div>
            </ScrollReveal>
          ))}

          {/* Ghost Card: More Coming */}
          <ScrollReveal step={7}>
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
                  Planned means not built yet.
                </p>
              </div>
              <div className="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-hairline/60 pt-3 font-mono text-[10px]">
                <span className="uppercase tracking-wider text-label">
                  reads
                </span>
                <span className="text-label">nothing yet</span>
              </div>
            </div>
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}
