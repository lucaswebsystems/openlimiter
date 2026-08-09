import { ScrollReveal } from "./scroll-reveal";
import { ButtonLink, Section, SectionHeading } from "./ui";

const paths = [
  {
    label: "Automatic",
    title: "The Claude Code statusline payload",
    detail:
      "Claude Code writes a session object to your statusline command on every render. When it carries a rate limit block, OpenLimiter validates it, caches it, and renders the fresh numbers in the same call.",
  },
  {
    label: "By hand",
    title: "A manual document in the state directory",
    detail:
      "Write manual.json with up to ten meters and every command picks it up. A row that breaks a rule is dropped, and the remaining rows still count.",
  },
  {
    label: "Scriptable",
    title: "The generic ingest command",
    detail:
      "Any script or agent can hand OpenLimiter a document on standard input or inline. Add a provider id and the document goes to that connector's own parser instead.",
  },
];

const commands = [
  { name: "init", detail: "write local configuration" },
  { name: "snapshot", detail: "show cached quota, optionally refresh first" },
  { name: "statusline", detail: "render one line, ingesting standard input" },
  { name: "hook", detail: "emit the agent context block" },
  { name: "ingest", detail: "accept quota from a script" },
  { name: "doctor", detail: "report connector detection and cache health" },
  { name: "demo", detail: "render synthetic fixtures" },
  { name: "export", detail: "print the cache as canonical JSON" },
];

export function Ingestion() {
  return (
    <Section id="ingestion">
      <ScrollReveal>
        <SectionHeading
          eyebrow="Ingestion"
          title="Three offline paths put data in front of it."
          lead="All three are local. Until one of them runs, every command honestly reports unknown rather than showing you a number it does not have."
        />
      </ScrollReveal>

      <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
        {paths.map((path, index) => (
          <ScrollReveal key={path.title} step={index * 2}>
            <div className="h-full rounded-xl border border-hairline bg-surface p-6">
              <p className="font-mono text-2xs uppercase tracking-widest text-muted">
                {path.label}
              </p>
              <h3 className="mt-3 font-sans text-base font-medium text-heading">{path.title}</h3>
              <p className="mt-2 font-sans text-sm leading-relaxed text-body">{path.detail}</p>
            </div>
          </ScrollReveal>
        ))}
      </div>

      <ScrollReveal step={6}>
        <div className="mt-8 overflow-hidden rounded-xl border border-hairline bg-surface">
          <div className="border-b border-hairline bg-canvas px-4 py-3">
            <span className="font-mono text-2xs uppercase tracking-widest text-muted">
              The commands that exist today
            </span>
          </div>
          <ul className="grid grid-cols-1 gap-x-8 gap-y-2 p-4 sm:grid-cols-2 sm:p-6">
            {commands.map((command) => (
              <li key={command.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <code className="font-mono text-2xs text-heading">openlimiter {command.name}</code>
                <span className="font-sans text-sm text-body">{command.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </ScrollReveal>

      <ScrollReveal step={7}>
        <div className="mt-6">
          <ButtonLink href="/docs/cli" tone="secondary">
            Full CLI reference
          </ButtonLink>
        </div>
      </ScrollReveal>
    </Section>
  );
}
