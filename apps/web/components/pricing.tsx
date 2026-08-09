import { ScrollReveal } from "./scroll-reveal";
import { ButtonLink, Chip, GitHubMark, Section, SectionHeading } from "./ui";
import { COFFEE_URL, REPO_URL, SPONSORS_URL } from "@/lib/site";

const freeIncludes = [
  "Every connector, with no provider locked behind a tier",
  "The statusline and the Claude Code prompt hook",
  "All eight CLI commands, including doctor and export",
  "All three ingestion paths",
  "No usage limit, no seat count, no account",
];

const cloudIncludes = [
  "Encrypted synchronisation across your own devices",
  "Mobile access to the same quota state",
  "Push alerts when a window is close to its cap",
];

export function Pricing() {
  return (
    <Section id="pricing">
      <ScrollReveal>
        <SectionHeading
          eyebrow="Pricing"
          title="The software is free. A hosted service would not be."
          lead="Everything that runs on your machine is free and stays free. No feature is locked, and there is no tier that unlocks one."
        />
      </ScrollReveal>

      <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ScrollReveal step={1}>
          <div className="flex h-full flex-col rounded-2xl border border-hairline bg-surface p-6 sm:p-8">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-sans text-lg font-medium text-heading">Free, and always free</h3>
              <Chip tone="strong">available now</Chip>
            </div>
            <p className="mt-5 font-sans text-4xl font-medium tracking-tight text-heading">
              $0
            </p>
            <p className="mt-4 font-sans text-sm leading-relaxed text-body">
              Everything that runs locally. Open source under Apache 2.0, so this is not a trial
              and cannot be taken away.
            </p>
            <ul className="mt-6 space-y-2.5">
              {freeIncludes.map((item) => (
                <li key={item} className="flex gap-3 font-sans text-sm leading-6 text-body">
                  <span
                    aria-hidden="true"
                    className="mt-2.5 h-1 w-1 flex-none rounded-full bg-accent-solid"
                  />
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-8 border-t border-hairline pt-6">
              <ButtonLink href="/docs" tone="primary" className="w-full">
                Read the docs
              </ButtonLink>
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal step={3}>
          <div className="flex h-full flex-col rounded-2xl border border-dashed border-hairline-strong bg-canvas p-6 sm:p-8">
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-sans text-lg font-medium text-heading">OpenLimiter Sync</h3>
              <Chip tone="accent">coming soon</Chip>
            </div>
            <p className="mt-5 font-sans text-4xl font-medium tracking-tight text-heading">
              $5
              <span className="ml-1.5 font-sans text-sm font-normal text-body">per month</span>
            </p>
            <p className="mt-4 font-sans text-sm leading-relaxed text-body">
              An optional hosted add on. You would be paying for servers that cost money to run,
              not for software that was withheld from you. The local tool would not change in any
              way if you never bought it.
            </p>
            <ul className="mt-6 space-y-2.5">
              {cloudIncludes.map((item) => (
                <li key={item} className="flex gap-3 font-sans text-sm leading-6 text-body">
                  <span
                    aria-hidden="true"
                    className="mt-2.5 h-1 w-1 flex-none rounded-full bg-hairline-strong"
                  />
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-8 border-t border-hairline pt-6">
              <p className="font-sans text-sm text-body">
                There is nothing to buy. No checkout exists, no waitlist is open, and no
                synchronisation service is running anywhere yet.
              </p>
            </div>
          </div>
        </ScrollReveal>
      </div>

      <ScrollReveal step={5}>
        <div className="mt-8 rounded-2xl border border-hairline bg-surface p-6 sm:p-8">
          <h3 className="font-sans text-base font-medium text-heading">
            If you want to support the work
          </h3>
          <p className="mt-2 max-w-2xl font-sans text-sm leading-relaxed text-body">
            Sponsorship is entirely optional and buys no feature. It funds the time that goes into
            the connectors and the docs.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <ButtonLink href={SPONSORS_URL} tone="secondary" external>
              <GitHubMark className="h-4 w-4" />
              GitHub Sponsors
            </ButtonLink>
            {/* Placeholder link. The Buy Me a Coffee account may not exist yet, so
                confirm the page has been claimed before promoting this anywhere. */}
            <ButtonLink href={COFFEE_URL} tone="secondary" external>
              Buy me a coffee
            </ButtonLink>
            <ButtonLink href={REPO_URL} tone="quiet" external>
              Or just star the repository
            </ButtonLink>
          </div>
        </div>
      </ScrollReveal>
    </Section>
  );
}
