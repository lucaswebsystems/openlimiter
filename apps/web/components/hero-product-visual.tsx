import { ScrollReveal } from "./scroll-reveal";

export function HeroProductVisual() {
  return (
    <section className="relative px-4 pb-20 sm:px-6 lg:px-8">
      {/* Background Soft Radial Glow (warm to cool blend) */}
      <div className="hero-glow-container" aria-hidden="true" />

      <div className="relative mx-auto max-w-5xl">
        <ScrollReveal delay={0.1}>
          {/* Polished Mock App Window (Terminal / Editor Panel) */}
          <div className="relative overflow-hidden rounded-xl border border-hairline bg-surface/90 shadow-2xl backdrop-blur-xl">
            {/* Window Header / Title Bar */}
            <div className="flex items-center justify-between border-b border-hairline px-4 py-3 bg-canvas/60">
              <div className="flex items-center gap-2">
                <span className="h-3 w-3 rounded-full bg-red-500/80 inline-block" />
                <span className="h-3 w-3 rounded-full bg-yellow-500/80 inline-block" />
                <span className="h-3 w-3 rounded-full bg-green-500/80 inline-block" />
                <span className="ml-2 font-mono text-xs text-label">
                  openlimiter status --live
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded border border-hairline bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-label">
                  Demo data
                </span>
              </div>
            </div>

            {/* Window Content */}
            <div className="p-4 sm:p-6 space-y-6 font-mono text-xs leading-relaxed text-body">
              {/* Section 1: Provider Budget Bars (Statusline Row) */}
              <div>
                <div className="mb-2 text-label font-medium uppercase tracking-wider text-[11px] flex justify-between">
                  <span>Active Provider Quota Statusline</span>
                  <span className="text-accent">SYNTHETIC SNAPSHOT</span>
                </div>
                <div className="rounded-lg border border-hairline bg-canvas/90 p-4 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <div className="flex items-center gap-2 min-w-[140px]">
                      <span className="h-2 w-2 rounded-full bg-emerald-400" />
                      <span className="text-heading font-medium">Claude Pro</span>
                    </div>
                    <div className="flex-1 max-w-xs bg-white/5 h-2 rounded-full overflow-hidden my-1 sm:my-0">
                      <div className="bg-emerald-400 h-full w-[82%]" />
                    </div>
                    <span className="text-emerald-400 text-right min-w-[120px]">
                      82% (4h 12m left)
                    </span>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <div className="flex items-center gap-2 min-w-[140px]">
                      <span className="h-2 w-2 rounded-full bg-amber-400" />
                      <span className="text-heading font-medium">Codex CLI</span>
                    </div>
                    <div className="flex-1 max-w-xs bg-white/5 h-2 rounded-full overflow-hidden my-1 sm:my-0">
                      <div className="bg-amber-400 h-full w-[98%]" />
                    </div>
                    <span className="text-amber-400 text-right min-w-[120px]">
                      98% (resetting)
                    </span>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <div className="flex items-center gap-2 min-w-[140px]">
                      <span className="h-2 w-2 rounded-full bg-accent" />
                      <span className="text-heading font-medium">Antigravity</span>
                    </div>
                    <div className="flex-1 max-w-xs bg-white/5 h-2 rounded-full overflow-hidden my-1 sm:my-0">
                      <div className="bg-accent h-full w-[40%]" />
                    </div>
                    <span className="text-accent text-right min-w-[120px]">
                      40% (active)
                    </span>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                    <div className="flex items-center gap-2 min-w-[140px]">
                      <span className="h-2 w-2 rounded-full bg-indigo-400" />
                      <span className="text-heading font-medium">OpenRouter</span>
                    </div>
                    <div className="flex-1 max-w-xs bg-white/5 h-2 rounded-full overflow-hidden my-1 sm:my-0">
                      <div className="bg-indigo-400 h-full w-[91%]" />
                    </div>
                    <span className="text-indigo-400 text-right min-w-[120px]">
                      91% ($14.20 / $15.00)
                    </span>
                  </div>
                </div>
              </div>

              {/* Section 2: Injected Agent Context Block */}
              <div>
                <div className="mb-2 text-label font-medium uppercase tracking-wider text-[11px] flex justify-between">
                  <span>Injected Agent Prompt Context</span>
                  <span className="text-label">LOCAL IPC PIPELINE</span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-hairline bg-canvas/90 p-4">
                  <pre className="text-body text-[11px] sm:text-xs">
                    <code>
                      <span className="text-label font-mono">{"// OpenLimiter Agent Context Block"}</span>
                      {"\n"}
                      <span className="text-heading">{`{`}</span>
                      {"\n"}  <span className="text-accent">&quot;status&quot;</span>: <span className="text-emerald-400">&quot;OK&quot;</span>,
                      {"\n"}  <span className="text-accent">&quot;timestamp&quot;</span>: <span className="text-heading">&quot;2026-08-09T00:39:35Z&quot;</span>,
                      {"\n"}  <span className="text-accent">&quot;recommended_provider&quot;</span>: <span className="text-emerald-400">&quot;anthropic_claude&quot;</span>,
                      {"\n"}  <span className="text-accent">&quot;available_budget_pct&quot;</span>: <span className="text-amber-300">82</span>,
                      {"\n"}  <span className="text-accent">&quot;freshness_sec&quot;</span>: <span className="text-amber-300">14</span>,
                      {"\n"}  <span className="text-accent">&quot;fallback_provider&quot;</span>: <span className="text-heading">&quot;openrouter_claude_3_7&quot;</span>
                      {"\n"}<span className="text-heading">{`}`}</span>
                    </code>
                  </pre>
                </div>
              </div>

              {/* Statusline Output Bar */}
              <div className="rounded border border-hairline bg-surface-hover/80 px-3 py-2 text-[11px] sm:text-xs text-body flex flex-wrap items-center gap-2">
                <span className="text-emerald-400 font-semibold">[OpenLimiter]</span>
                <span>Active: Claude Pro (82% remaining)</span>
                <span className="text-hairline">|</span>
                <span className="text-accent font-medium">Advice: PREFER_CLAUDE</span>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
