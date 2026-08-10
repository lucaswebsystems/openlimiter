import Link from "next/link";
import { BrandLockup } from "./brand";
import { GitHubMark, SHELL } from "./ui";
import { platformTargets } from "@/lib/downloads";
import { reveal } from "@/lib/motion";
import {
  AUTHOR_EMAIL,
  AUTHOR_GITHUB,
  AUTHOR_LINKEDIN,
  AUTHOR_NAME,
  AUTHOR_SITE,
  COFFEE_URL,
  DISCUSSIONS_URL,
  ISSUES_URL,
  LICENSE_URL,
  REPO_URL,
  SPONSORS_URL,
} from "@/lib/site";

/**
 * The footer.
 *
 * A brand block that says who made this and how to reach him, then three
 * columns of links that all point at something that exists. The columns are
 * short on purpose: a footer that lists every provider and every comparison
 * page is a sitemap, not a footer, and the two columns that did that are gone.
 * Comparisons live in the header, where a reader looking for them will be.
 *
 * The Download column is generated from the same data the download page renders,
 * so a platform cannot be listed here and missing from the page it points at.
 * There is no Discord link anywhere on this site, by instruction.
 */

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

const product: FooterLink[] = [
  { label: "Docs", href: "/docs" },
  { label: "Changelog", href: "/changelog" },
  { label: "Blog", href: "/blog" },
  { label: "Roadmap", href: "/docs/roadmap" },
  { label: "Security", href: "/docs/security" },
];

const download: FooterLink[] = platformTargets.map((target) => ({
  label: target.name,
  href: `/download#${target.id}`,
}));

const community: FooterLink[] = [
  { label: "GitHub", href: REPO_URL, external: true },
  { label: "Issues", href: ISSUES_URL, external: true },
  { label: "Discussions", href: DISCUSSIONS_URL, external: true },
  { label: "GitHub Sponsors", href: SPONSORS_URL, external: true },
  { label: "Buy me a coffee", href: COFFEE_URL, external: true },
];

/*
  The link rows.

  Each row is a flex line rather than a block, so the chevron and the label are
  one object: the glyph is 12 pixels, sits on the text baseline box, and slides
  two pixels to the right under a pointer, which is the same two pixel gesture
  the cards on this site make. `leading-5` pulls the lists a step tighter than
  the surrounding text, which is what makes a column read as a list rather than
  as loose paragraphs.
*/
const linkClass =
  "focus-ring group inline-flex items-center gap-1 rounded py-0.5 leading-5 text-muted transition-colors duration-200 hover:text-heading";

const contactClass =
  "focus-ring inline-flex items-center gap-2 rounded text-muted transition-colors duration-200 hover:text-heading";

function LinkChevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3 flex-none text-muted transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function Column({ title, links }: { title: string; links: readonly FooterLink[] }) {
  return (
    <div className="space-y-3" {...reveal}>
      <p className="heading-face text-heading">{title}</p>
      <div className="flex flex-col items-start gap-0.5">
        {links.map((link) =>
          link.external === true ? (
            <a
              key={`${link.label}-${link.href}`}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              <LinkChevron />
              {link.label}
            </a>
          ) : (
            <Link key={`${link.label}-${link.href}`} href={link.href} className={linkClass}>
              <LinkChevron />
              {link.label}
            </Link>
          ),
        )}
      </div>
    </div>
  );
}

function LinkedInMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} fill-current`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3V9Zm6.5 0h3.8v1.64h.05c.53-.95 1.83-1.95 3.76-1.95 4.02 0 4.76 2.5 4.76 5.76V21h-4v-5.66c0-1.35-.03-3.09-1.94-3.09-1.94 0-2.24 1.47-2.24 2.99V21h-3.99V9Z" />
    </svg>
  );
}

function GlobeMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" />
    </svg>
  );
}

function MailMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="2.5" />
      <path d="m3.5 7.5 7.4 5.1a2 2 0 0 0 2.2 0l7.4-5.1" />
    </svg>
  );
}

export function Footer() {
  return (
    <footer className={`${SHELL} pb-8 pt-4 md:pb-16`}>
      <div className="grid gap-10 border-t border-hairline pt-10 text-sm lg:grid-cols-[1.6fr_1fr_1fr_1fr]">
        <div className="max-w-sm space-y-4" {...reveal}>
          <Link href="/" aria-label="OpenLimiter, home" className="focus-ring inline-flex rounded">
            <BrandLockup
              markClassName="h-8 w-8 flex-none text-brand"
              wordClassName="text-xl"
            />
          </Link>
          <p className="leading-relaxed text-muted">
            Quota awareness for AI coding agents. It reads what your subscriptions have left on your
            own machine, hands your agents a bounded block of that state, and never invents a number
            it does not have.
          </p>
          <div className="space-y-2">
            <p className="text-muted">
              Built by <span className="text-heading">{AUTHOR_NAME}</span>
            </p>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <a
                href={AUTHOR_SITE}
                target="_blank"
                rel="noopener noreferrer"
                className={contactClass}
              >
                <GlobeMark />
                lucaswebsystems.com
              </a>
              <a href={`mailto:${AUTHOR_EMAIL}`} className={contactClass}>
                <MailMark />
                {AUTHOR_EMAIL}
              </a>
              <a
                href={AUTHOR_LINKEDIN}
                target="_blank"
                rel="noopener noreferrer"
                className={contactClass}
              >
                <LinkedInMark />
                LinkedIn
              </a>
              <a
                href={AUTHOR_GITHUB}
                target="_blank"
                rel="noopener noreferrer"
                className={contactClass}
              >
                <GitHubMark />
                GitHub
              </a>
            </div>
          </div>
        </div>

        <Column title="Product" links={product} />
        <Column title="Download" links={download} />
        <Column title="Community" links={community} />
      </div>

      <p className="pt-10 text-xs text-muted" {...reveal}>
        Apache 2.0. Local first. Zero telemetry in the software. No accounts. This site keeps
        cookieless page counts only.{" "}
        <a
          href={LICENSE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
        >
          Read the licence
        </a>
        .
      </p>
    </footer>
  );
}
