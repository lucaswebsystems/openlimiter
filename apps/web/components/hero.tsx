import { ScrollReveal } from "./scroll-reveal";
import { ButtonLink, GitHubMark } from "./ui";
import { REPO_URL } from "@/lib/site";

const supports = ["Claude", "OpenRouter", "Codex", "Antigravity", "OpenCode", "Manual"];

export function Hero() {
  return (
    <section className="px-4 pb-14 pt-16 sm:px-6 md:pb-16 md:pt-24 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="max-w-3xl">
            <h1 className="font-sans text-4xl font-medium tracking-tight text-heading sm:text-5xl md:text-6xl md:leading-[1.06]">
              Know which subscription
              <br />
              still has room.
            </h1>
            <p className="mt-6 max-w-2xl font-sans text-base leading-relaxed text-body sm:text-lg">
              OpenLimiter reads the quota of your AI subscriptions on your own machine and hands
              your coding agents a bounded picture of what budget is left. Open source, local
              first, zero telemetry, no accounts.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/docs" tone="primary">
                Read the docs
              </ButtonLink>
              <ButtonLink href={REPO_URL} tone="secondary" external>
                <GitHubMark className="h-4 w-4" />
                View on GitHub
              </ButtonLink>
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal step={2}>
          <div className="mt-12 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline pt-6">
            <span className="font-mono text-2xs uppercase tracking-widest text-muted">
              Supports
            </span>
            <span aria-hidden="true" className="h-3.5 w-px bg-hairline-strong" />
            <ul className="flex flex-wrap items-center gap-2">
              {supports.map((name) => (
                <li
                  key={name}
                  className="rounded-md border border-hairline bg-surface px-2 py-0.5 font-mono text-2xs text-heading"
                >
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
