import { ScrollReveal } from "./scroll-reveal";
import { ButtonLink, GitHubMark, Section, SectionHeading } from "./ui";
import { LICENSE_URL, REPO_URL } from "@/lib/site";

const facts = [
  { label: "Licence", value: "Apache 2.0" },
  { label: "Telemetry", value: "none, anywhere" },
  { label: "Accounts", value: "none required" },
  { label: "Egress in this release", value: "none at all" },
  { label: "Stack", value: "TypeScript monorepo" },
  { label: "Continuous integration", value: "Windows and Linux" },
];

export function OpenSource() {
  return (
    <Section id="open-source">
      <ScrollReveal>
        <SectionHeading
          eyebrow="Open source"
          title="Local first, and there is nothing to trust us with."
          lead="OpenLimiter runs on your machine. There are no tracking scripts, no remote logs, no accounts, and no OpenLimiter server to receive anything, because none exists. Quota state is written locally and stays there."
        />
      </ScrollReveal>

      <ScrollReveal step={2}>
        <div className="mt-10 rounded-2xl border border-hairline bg-surface p-6 sm:p-8">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {facts.map((fact) => (
              <div key={fact.label} className="border-t border-hairline pt-4">
                <dt className="font-mono text-2xs uppercase tracking-widest text-muted">
                  {fact.label}
                </dt>
                <dd className="mt-1.5 font-sans text-sm font-medium text-heading">{fact.value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-hairline pt-6">
            <ButtonLink href={REPO_URL} tone="secondary" external>
              <GitHubMark className="h-4 w-4" />
              Read the source
            </ButtonLink>
            <ButtonLink href="/docs/security" tone="secondary">
              Security and privacy
            </ButtonLink>
            <ButtonLink href={LICENSE_URL} tone="secondary" external>
              Apache 2.0 licence
            </ButtonLink>
          </div>
        </div>
      </ScrollReveal>
    </Section>
  );
}
