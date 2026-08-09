import { ScrollReveal } from "./scroll-reveal";

export function AgentContextExample() {
  return (
    <section className="py-20 px-4 sm:px-6 lg:px-8 border-t border-hairline">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="mb-10 max-w-2xl">
            <h2 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
              Agent context format
            </h2>
            <p className="mt-2 font-sans text-sm text-body">
              Bounded, safe, never raw provider text.
            </p>
          </div>
        </ScrollReveal>

        <ScrollReveal step={2}>
          <div className="overflow-hidden rounded-xl border border-hairline bg-surface/90 shadow-xl">
            {/* Header bar */}
            <div className="flex items-center justify-between border-b border-hairline px-4 py-3 bg-canvas/60">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/70 inline-block" />
                <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70 inline-block" />
                <span className="h-2.5 w-2.5 rounded-full bg-green-500/70 inline-block" />
                <span className="ml-2 font-mono text-xs text-label">
                  openlimiter context --format=json
                </span>
              </div>
              <span className="rounded border border-hairline bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-label">
                Demo data
              </span>
            </div>

            {/* Content panel */}
            <div className="p-4 sm:p-6 space-y-6 font-mono text-xs">
              <div>
                <div className="text-label text-[11px] uppercase tracking-wider mb-2 font-medium">
                  Sample Prompt Context Payload
                </div>
                <div className="rounded-lg border border-hairline bg-canvas/90 p-4 overflow-x-auto">
                  <pre className="text-body text-[11px] sm:text-xs">
                    <code>
                      <span className="text-label font-mono">{"// Safe payload injected into agent workspace prompt"}</span>
                      {"\n"}
                      <span className="text-heading">{`{`}</span>
                      {"\n"}  <span className="text-accent">&quot;openlimiter_version&quot;</span>: <span className="text-heading">&quot;0.1.0&quot;</span>,
                      {"\n"}  <span className="text-accent">&quot;active_provider&quot;</span>: <span className="text-emerald-400">&quot;claude_code&quot;</span>,
                      {"\n"}  <span className="text-accent">&quot;token_budget_percentage&quot;</span>: <span className="text-amber-300">82</span>,
                      {"\n"}  <span className="text-accent">&quot;window_remaining_minutes&quot;</span>: <span className="text-amber-300">252</span>,
                      {"\n"}  <span className="text-accent">&quot;rate_limit_state&quot;</span>: <span className="text-emerald-400">&quot;HEALTHY&quot;</span>,
                      {"\n"}  <span className="text-accent">&quot;recommended_route&quot;</span>: <span className="text-heading">&quot;PREFER_CURRENT_SESSION&quot;</span>
                      {"\n"}<span className="text-heading">{`}`}</span>
                    </code>
                  </pre>
                </div>
              </div>

              <div>
                <div className="text-label text-[11px] uppercase tracking-wider mb-2 font-medium">
                  Sample Statusline String
                </div>
                <div className="rounded-lg border border-hairline bg-canvas/90 p-3 text-[11px] sm:text-xs text-body flex items-center gap-2 overflow-x-auto">
                  <span className="text-emerald-400 font-semibold">[OL]</span>
                  <span className="text-heading">Claude: 82%</span>
                  <span aria-hidden="true" className="text-label">|</span>
                  <span className="text-heading">Codex: 98%</span>
                  <span aria-hidden="true" className="text-label">|</span>
                  <span className="text-accent">Route: Claude</span>
                </div>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
