import Link from "next/link";
import { alternatives } from "@/lib/alternatives";
import { downloadTargets } from "@/lib/downloads";
import {
  AUTHOR_NAME,
  AUTHOR_SITE,
  DISCUSSIONS_URL,
  ISSUES_URL,
  LICENSE_URL,
  REPO_URL,
  SPONSORS_URL,
} from "@/lib/site";

/**
 * Five columns on a wide screen, two on a narrow one, over a single hairline.
 *
 * The Alternatives and Download columns are generated from the same data the
 * pages themselves render, so a row can never exist in the footer and be
 * missing from the page it points at. There is no Discord link anywhere on this
 * site, by instruction.
 */

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

const product: FooterLink[] = [
  { label: "Documentation", href: "/docs" },
  { label: "Changelog", href: "/changelog" },
  { label: "Blog", href: "/blog" },
  { label: "Roadmap", href: "/docs/roadmap" },
  { label: "Security", href: "/docs/security" },
];

const agents: FooterLink[] = [
  { label: "Claude Code", href: "/docs/agent-context" },
  { label: "Codex CLI", href: "/docs/providers" },
  { label: "OpenCode", href: "/docs/providers" },
  { label: "Antigravity", href: "/docs/providers" },
  { label: "All providers", href: "/docs/providers" },
];

const alternativeLinks: FooterLink[] = alternatives.map((entry) => ({
  label: entry.name,
  href: `/alternatives/${entry.slug}`,
}));

const community: FooterLink[] = [
  { label: "GitHub", href: REPO_URL, external: true },
  { label: "Issues", href: ISSUES_URL, external: true },
  { label: "Discussions", href: DISCUSSIONS_URL, external: true },
  { label: "Sponsor", href: SPONSORS_URL, external: true },
  { label: "Apache 2.0 licence", href: LICENSE_URL, external: true },
];

const download: FooterLink[] = downloadTargets
  .filter((target) => target.state === "available")
  .map((target) => ({ label: target.name, href: `/download#${target.id}` }));

const linkClass = "focus-ring rounded text-muted transition-colors hover:text-heading";

function Column({ title, links }: { title: string; links: readonly FooterLink[] }) {
  return (
    <div className="space-y-3">
      <p className="font-medium text-heading">{title}</p>
      <div className="space-y-2">
        {links.map((link) => (
          <div key={`${link.label}-${link.href}`}>
            {link.external === true ? (
              <a href={link.href} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {link.label}
              </a>
            ) : (
              <Link href={link.href} className={linkClass}>
                {link.label}
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="mx-auto max-w-5xl p-6 md:p-20 md:pt-0">
      <div className="grid grid-cols-2 gap-8 border-t border-hairline pb-4 pt-8 text-sm sm:grid-cols-5">
        <Column title="Product" links={product} />
        <Column title="Agents" links={agents} />
        <Column title="Alternatives" links={alternativeLinks} />
        <Column title="Community" links={community} />
        <Column title="Download" links={download} />
      </div>
      <p className="pt-6 text-xs text-muted">
        Apache 2.0. Local first. Zero telemetry. No accounts. Built by{" "}
        <a
          href={AUTHOR_SITE}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
        >
          {AUTHOR_NAME}
        </a>
        .
      </p>
    </footer>
  );
}
