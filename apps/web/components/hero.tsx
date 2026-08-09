import { ScrollReveal } from "./scroll-reveal";

export function Hero() {
  return (
    <section className="relative px-4 pt-16 pb-12 sm:px-6 md:pt-24 md:pb-16 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="max-w-3xl text-left">
            <h1 className="font-sans text-4xl font-medium tracking-tight text-heading sm:text-5xl md:text-6xl md:leading-[1.08]">
              Know your limits.
              <br />
              Route around them.
            </h1>
            <p className="mt-6 font-sans text-base font-normal leading-relaxed text-body sm:text-lg">
              OpenLimiter reads your supported AI subscriptions and tells your
              coding agents which one still has budget, right inside their own
              context. Open source, local first, cross platform.
            </p>

            {/* Button Row */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <a
                href="https://github.com/lucaswebsystems/openlimiter"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg bg-btn-primary-bg px-5 py-2.5 font-sans text-xs font-semibold text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
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
              <a
                href="https://github.com/lucaswebsystems/openlimiter#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-hairline bg-surface/40 px-5 py-2.5 font-sans text-xs font-medium text-heading transition-colors hover:border-hairline-strong hover:bg-surface"
              >
                Read the docs
              </a>
            </div>

            {/* Supports Row */}
            <div className="mt-10 flex flex-wrap items-center gap-2.5 pt-4 border-t border-hairline/50">
              <span className="font-mono text-xs font-medium text-label uppercase tracking-wider">
                Supports
              </span>
              <span className="h-3.5 w-px bg-hairline" />
              <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-body">
                <span className="rounded border border-hairline bg-surface/60 px-2 py-0.5 text-heading">
                  Claude
                </span>
                <span className="rounded border border-hairline bg-surface/60 px-2 py-0.5 text-heading">
                  Codex
                </span>
                <span className="rounded border border-hairline bg-surface/60 px-2 py-0.5 text-heading">
                  Antigravity
                </span>
                <span className="rounded border border-hairline bg-surface/60 px-2 py-0.5 text-heading">
                  OpenCode
                </span>
                <span className="rounded border border-hairline bg-surface/60 px-2 py-0.5 text-heading">
                  OpenRouter
                </span>
                <span className="rounded border border-hairline bg-accent-subtle px-2 py-0.5 text-accent text-[11px]">
                  plus more
                </span>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
