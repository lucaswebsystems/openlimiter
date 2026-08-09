import { ScrollReveal } from "./scroll-reveal";

export function CrossPlatform() {
  const osTiles = [
    {
      name: "Windows",
      badge: "first class",
      description: "PowerShell, Windows Terminal, and WSL2 first class support.",
    },
    {
      name: "macOS",
      badge: "cross platform",
      description: "Native zsh and bash shell integration for Apple Silicon and Intel.",
    },
    {
      name: "Linux",
      badge: "cross platform",
      description: "Lightweight binary distribution for glibc and musl systems.",
    },
  ];

  return (
    <section className="py-20 px-4 sm:px-6 lg:px-8 border-t border-hairline">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="mb-10 text-left">
            <h2 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
              Built on Windows, made for every desk.
            </h2>
            <p className="mt-2 font-sans text-sm text-body">
              Windows first class, macOS and Linux cross platform.
            </p>
          </div>
        </ScrollReveal>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {osTiles.map((tile, idx) => (
            <ScrollReveal key={tile.name} step={idx * 2}>
              <div className="h-full rounded-xl border border-hairline bg-surface/40 p-6 transition-colors hover:border-hairline-strong hover:bg-surface/70">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h3 className="font-sans text-lg font-medium text-heading">
                    {tile.name}
                  </h3>
                  <span className="rounded border border-hairline bg-canvas px-2 py-0.5 font-mono text-[10px] font-medium text-label">
                    {tile.badge}
                  </span>
                </div>
                <p className="font-sans text-xs text-body leading-relaxed">
                  {tile.description}
                </p>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}
