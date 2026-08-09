import Link from "next/link";
import { docPages } from "@/lib/docs";
import {
  AUTHOR_GITHUB,
  AUTHOR_LINKEDIN,
  AUTHOR_NAME,
  AUTHOR_SITE,
  COFFEE_URL,
  DISCUSSIONS_URL,
  ISSUES_URL,
  LICENSE_URL,
  RELEASES_URL,
  REPO_URL,
  SPONSORS_URL,
} from "@/lib/site";

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

const product: FooterLink[] = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Providers", href: "/#providers" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Roadmap", href: "/#roadmap" },
  { label: "Frequently asked questions", href: "/#faq" },
];

const docs: FooterLink[] = docPages.slice(0, 5).map((page) => ({
  label: page.title,
  href: page.href,
}));

const community: FooterLink[] = [
  { label: "Repository", href: REPO_URL, external: true },
  { label: "Issues", href: ISSUES_URL, external: true },
  { label: "Discussions", href: DISCUSSIONS_URL, external: true },
  { label: "Releases", href: RELEASES_URL, external: true },
  { label: "Apache 2.0 licence", href: LICENSE_URL, external: true },
];

const support: FooterLink[] = [
  { label: "GitHub Sponsors", href: SPONSORS_URL, external: true },
  { label: "Buy me a coffee", href: COFFEE_URL, external: true },
];

function Column({ title, links }: { title: string; links: readonly FooterLink[] }) {
  return (
    <div>
      <h2 className="mb-4 font-mono text-2xs uppercase tracking-widest text-muted">{title}</h2>
      <ul className="space-y-2.5">
        {links.map((link) => (
          <li key={link.label}>
            {link.external === true ? (
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-ring rounded font-sans text-sm text-body transition-colors hover:text-heading"
              >
                {link.label}
              </a>
            ) : (
              <Link
                href={link.href}
                className="focus-ring rounded font-sans text-sm text-body transition-colors hover:text-heading"
              >
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-hairline bg-canvas px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-5">
          <div className="lg:col-span-1">
            <Link href="/" className="focus-ring inline-flex items-center gap-2.5 rounded-md">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-hairline-strong bg-surface font-sans text-2xs font-semibold text-heading"
              >
                OL
              </span>
              <span className="font-sans text-sm font-medium tracking-tight text-heading">
                OpenLimiter
              </span>
            </Link>
            <p className="mt-4 max-w-xs font-sans text-sm leading-relaxed text-body">
              An open source quota meter for the AI subscriptions you already pay for. It runs on
              your machine and reports to nobody.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4 lg:col-span-4">
            <Column title="Product" links={product} />
            <Column title="Docs" links={docs} />
            <Column title="Community" links={community} />
            <Column title="Support" links={support} />
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-hairline pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-2xs text-muted">
            Apache 2.0. Local first. Zero telemetry. No accounts.
          </p>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-2xs text-muted">
            <span>
              Built by{" "}
              <a
                href={AUTHOR_SITE}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
              >
                {AUTHOR_NAME}
              </a>
            </span>
            <a
              href={AUTHOR_GITHUB}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring rounded transition-colors hover:text-heading"
            >
              GitHub
            </a>
            <a
              href={AUTHOR_LINKEDIN}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring rounded transition-colors hover:text-heading"
            >
              LinkedIn
            </a>
          </p>
        </div>
      </div>
    </footer>
  );
}
