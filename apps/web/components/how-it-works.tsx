import { ScrollReveal } from "./scroll-reveal";

export function HowItWorks() {
  const steps = [
    {
      title: "Read",
      subtitle: "Detects your installed AI tools and reads quota locally",
      description:
        "OpenLimiter inspects local session stores, configuration files, and key credentials to read active budget windows directly.",
    },
    {
      title: "Normalize",
      subtitle:
        "One snapshot schema, freshness aware, unknown never becomes a fake zero",
      description:
        "Standardizes disparate quota metrics into a single snapshot model. If a provider endpoint is unreachable, status remains unknown rather than zero.",
    },
    {
      title: "Advise",
      subtitle: "A statusline for you, bounded context for your agents",
      description:
        "Exposes a lightweight statusline string for your terminal and injects bounded JSON context into agent prompt environments.",
    },
  ];

  return (
    <section id="how-it-works" className="py-20 px-4 sm:px-6 lg:px-8 border-t border-hairline">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="mb-12">
            <h2 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
              How it works
            </h2>
            <p className="mt-2 font-sans text-sm text-body">
              Three quiet steps from local credentials to agent awareness.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {steps.map((step, idx) => (
            <ScrollReveal key={step.title} step={idx * 2}>
              <div className="h-full rounded-xl border border-hairline bg-surface/40 p-6 transition-colors hover:border-hairline-strong hover:bg-surface/70 flex flex-col justify-between">
                <div>
                  <div className="font-mono text-xs font-medium text-accent mb-4">
                    0{idx + 1}
                  </div>
                  <h3 className="font-sans text-xl font-medium tracking-tight text-heading">
                    {step.title}
                  </h3>
                  <p className="mt-2 font-sans text-xs font-semibold text-heading/90 leading-snug">
                    {step.subtitle}
                  </p>
                  <p className="mt-3 font-sans text-xs text-body leading-relaxed">
                    {step.description}
                  </p>
                </div>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
