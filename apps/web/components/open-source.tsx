import {
  ArrowUpRight,
  EyeSlash,
  FolderOpen,
  LockKey,
} from "@phosphor-icons/react/dist/ssr";
import { links } from "@/components/links";
import { ScrollReveal } from "@/components/scroll-reveal";
import { ExternalLink, IconChip } from "@/components/ui";

const principles = [
  {
    icon: FolderOpen,
    title: "Apache 2.0",
    body: "Use it, inspect it, and contribute to it.",
  },
  {
    icon: EyeSlash,
    title: "Zero telemetry",
    body: "No usage analytics leave your machine.",
  },
  {
    icon: LockKey,
    title: "No account",
    body: "Local features need no OpenLimiter account.",
  },
] as const;

export function OpenSource() {
  return (
    <section className="section section-tinted" aria-labelledby="source-title">
      <ScrollReveal className="content-container source-grid">
        <div data-reveal-item>
          <p className="eyebrow">Transparent by default</p>
          <h2 id="source-title" className="section-title">
            Local first. Open source. Yours to inspect.
          </h2>
          <p className="section-copy">
            OpenLimiter keeps the free workflow on your machine, ships with zero
            telemetry, and asks for no account. The architecture and security
            model are public.
          </p>
          <div className="text-links">
            <ExternalLink href={links.security}>
              SECURITY.md
              <ArrowUpRight size={16} weight="regular" aria-hidden="true" />
            </ExternalLink>
            <ExternalLink href={links.architecture}>
              ARCHITECTURE.md
              <ArrowUpRight size={16} weight="regular" aria-hidden="true" />
            </ExternalLink>
          </div>
        </div>

        <div className="principle-list" data-reveal-item>
          {principles.map((principle) => (
            <article key={principle.title} className="principle-item">
              <IconChip icon={principle.icon} />
              <div>
                <h3>{principle.title}</h3>
                <p>{principle.body}</p>
              </div>
            </article>
          ))}
        </div>
      </ScrollReveal>
    </section>
  );
}
