import { ScrollReveal } from "./scroll-reveal";

export function Pricing() {
  return (
    <section id="pricing" className="py-20 px-4 sm:px-6 lg:px-8 border-t border-hairline">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="mb-12 text-left">
            <h2 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
              Pricing
            </h2>
            <p className="mt-2 font-sans text-sm text-body">
              Local core is free forever. Cloud sync features coming later.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card 1: Free */}
          <ScrollReveal delay={0.05}>
            <div className="h-full rounded-2xl border border-hairline bg-surface/40 p-8 flex flex-col justify-between transition-colors hover:border-hairline-strong">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-sans text-xl font-medium text-heading">
                    Free
                  </h3>
                  <span className="rounded border border-hairline bg-canvas px-2.5 py-0.5 font-mono text-[10px] font-medium text-emerald-400">
                    FOREVER
                  </span>
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="font-sans text-4xl font-medium tracking-tight text-heading">
                    $0
                  </span>
                </div>
                <p className="mt-4 font-sans text-xs text-body leading-relaxed">
                  Everything local forever: all connectors, statusline, agent context, doctor, unlimited.
                </p>
              </div>

              <div className="mt-8 pt-6 border-t border-hairline">
                <a
                  href="https://github.com/lucaswebsystems/openlimiter"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center rounded-lg border border-hairline bg-btn-primary-bg px-4 py-2.5 font-sans text-xs font-semibold text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
                >
                  Star on GitHub
                </a>
              </div>
            </div>
          </ScrollReveal>

          {/* Card 2: Pro */}
          <ScrollReveal delay={0.15}>
            <div className="h-full rounded-2xl border border-hairline bg-surface/20 p-8 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-sans text-xl font-medium text-heading">
                    Pro
                  </h3>
                  <span className="rounded border border-hairline bg-accent-subtle px-2.5 py-0.5 font-mono text-[10px] font-medium text-accent">
                    COMING SOON
                  </span>
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="font-sans text-4xl font-medium tracking-tight text-heading">
                    $4.99
                  </span>
                  <span className="font-sans text-xs text-body">/ month</span>
                </div>
                <p className="mt-4 font-sans text-xs text-body leading-relaxed">
                  Encrypted sync, mobile access, push and email alerts, longer retention, team views later.
                </p>
              </div>

              <div className="mt-8 pt-6 border-t border-hairline">
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full text-center rounded-lg border border-hairline bg-surface/50 px-4 py-2.5 font-sans text-xs font-medium text-label transition-colors hover:border-hairline-strong hover:text-heading"
                >
                  Join the waitlist
                </a>
              </div>
            </div>
          </ScrollReveal>
        </div>

        {/* Support the build quiet line */}
        <ScrollReveal delay={0.25}>
          <div className="mt-10 text-center font-sans text-xs text-body">
            Support the build at{" "}
            <a
              href="https://github.com/sponsors/lucaswebsystems"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent transition-colors hover:text-accent-hover underline underline-offset-4"
            >
              https://github.com/sponsors/lucaswebsystems
            </a>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
