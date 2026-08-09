import { ScrollReveal } from "./scroll-reveal";

export function OpenSource() {
  const badges = [
    "Apache 2.0",
    "zero telemetry",
    "local first",
    "no accounts",
  ];

  return (
    <section className="py-20 px-4 sm:px-6 lg:px-8 border-t border-hairline">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="rounded-2xl border border-hairline bg-surface/40 p-8 sm:p-10">
            <div className="max-w-3xl">
              <h2 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
                Open source and transparent
              </h2>
              <p className="mt-4 font-sans text-sm text-body leading-relaxed">
                OpenLimiter runs on your machine. There are no tracking scripts, no
                remote log collection, no accounts, and no OpenLimiter server to
                receive anything. The only requests it makes go to a provider&apos;s
                own endpoint to read your quota, with credentials you already have.
                Your quota state is written locally and stays there.
              </p>

              {/* Badges */}
              <div className="mt-6 flex flex-wrap gap-2">
                {badges.map((b) => (
                  <span
                    key={b}
                    className="rounded-full border border-hairline bg-canvas px-3 py-1 font-mono text-xs text-heading"
                  >
                    {b}
                  </span>
                ))}
              </div>

              {/* Links to Docs */}
              <div className="mt-8 flex flex-wrap items-center gap-6 pt-6 border-t border-hairline">
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/blob/main/ARCHITECTURE.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs font-medium text-accent transition-colors hover:text-accent-hover"
                >
                  Architecture docs &rarr;
                </a>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/blob/main/SECURITY.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs font-medium text-accent transition-colors hover:text-accent-hover"
                >
                  Security model &rarr;
                </a>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/blob/main/THREAT_MODEL.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs font-medium text-accent transition-colors hover:text-accent-hover"
                >
                  Threat model &rarr;
                </a>
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
