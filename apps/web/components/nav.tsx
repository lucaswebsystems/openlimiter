import Link from "next/link";
import { BrandLockup } from "./brand";
import { ThemeToggle } from "./theme-toggle";
import { GitHubMark, SHELL } from "./ui";
import { fetchStarCount, formatStarCount } from "@/lib/github";
import { REPO_URL, SPONSORS_URL } from "@/lib/site";

/**
 * The header.
 *
 * Static position, no background, no bottom border, no backdrop filter and 28
 * pixels tall, which is the whole of it. It scrolls away with the page. There
 * is no hamburger either: below the medium breakpoint the row becomes a column
 * and the links wrap, so the entire header ships without a line of client side
 * JavaScript apart from the theme toggle.
 *
 * The star count comes from the GitHub API at render time and is cached for an
 * hour. When that request cannot be trusted the chip renders as a plain link
 * with no number: see lib/github.ts, which can only ever return a real count or
 * nothing at all.
 */

const links = [
  { label: "Docs", href: "/docs" },
  { label: "Web app", href: "/app" },
  { label: "Download", href: "/download" },
  { label: "Changelog", href: "/changelog" },
  { label: "Blog", href: "/blog" },
  { label: "Alternatives", href: "/alternatives" },
];

const linkClass =
  "focus-ring rounded text-sm text-muted transition-colors duration-200 hover:text-heading";

export async function Nav() {
  const stars = await fetchStarCount();

  return (
    <nav className={`${SHELL} mb-16 pt-6 md:pt-16`}>
      <header className="flex flex-col items-center gap-4 md:flex-row md:justify-between">
        <Link href="/" aria-label="OpenLimiter, home" className="focus-ring flex rounded">
          {/* The one instance allowed to play the draw in. See lib/brand.ts. */}
          <BrandLockup draw />
        </Link>

        <div className="flex flex-wrap items-center justify-center gap-4">
          {links.map((link) => (
            <Link key={link.label} href={link.href} className={linkClass}>
              {link.label}
            </Link>
          ))}
          <a
            href={SPONSORS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={linkClass}
          >
            Sponsor
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={
              stars === null
                ? "OpenLimiter on GitHub"
                : `OpenLimiter on GitHub, ${stars} stars`
            }
            className={`${linkClass} inline-flex items-center gap-1.5`}
          >
            <GitHubMark className="h-[18px] w-[18px]" />
            {stars !== null && <span className="text-sm">{formatStarCount(stars)}</span>}
          </a>
          <ThemeToggle />
        </div>
      </header>
    </nav>
  );
}
