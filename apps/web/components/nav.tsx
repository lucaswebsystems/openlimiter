import Link from "next/link";
import { BrandLockup } from "./brand";
import { NavSheet } from "./nav-sheet";
import { ThemeToggle } from "./theme-toggle";
import { GitHubMark, SHELL } from "./ui";
import { fetchStarCount, formatStarCount } from "@/lib/github";
import { REPO_URL, SPONSORS_URL } from "@/lib/site";

/**
 * The header.
 *
 * Static position, no background, no bottom border and no backdrop filter. It
 * scrolls away with the page.
 *
 * TWO LAYOUTS, AND NEITHER OF THEM WRAPS
 * --------------------------------------
 * The row used to be one flex container that wrapped, which was fine when it
 * held four links and became a defect when it held seven: at phone width the
 * links piled into three stacked rows and ate most of the screen before the
 * hero. So the wide layout is the row it always was, and below the medium
 * breakpoint the links move into a disclosure behind a hamburger, leaving one
 * tight line: the mark, the theme toggle, Get Pro, and the button that opens
 * the rest.
 *
 * It is a `details` element, so the sheet still ships without a line of client
 * side JavaScript. It opens on click or Enter, closes the same way, and closes
 * on Escape because that is what a `details` does natively.
 *
 * The star count comes from the GitHub API at render time and is cached for an
 * hour. When that request cannot be trusted the chip renders as a plain link
 * with no number: see lib/github.ts, which can only ever return a real count or
 * nothing at all.
 */

/**
 * The header links.
 *
 * Blog is not among them any more. The route is alive and the footer still
 * carries it, but a header is a list of the things a first visit needs, and one
 * post does not earn a slot beside the download.
 */
const links = [
  { label: "Docs", href: "/docs" },
  { label: "Web app", href: "/app" },
  { label: "Download", href: "/download" },
  { label: "Changelog", href: "/changelog" },
  { label: "Alternatives", href: "/alternatives" },
];

const linkClass =
  "focus-ring rounded text-sm text-muted transition-colors duration-200 hover:text-heading";

/**
 * The one filled control in the header, and it goes to the price on this page.
 *
 * It is not a checkout, because there is no checkout: nothing here takes money
 * yet, and a button that looked like it did would be the first untrue thing on
 * the site. It scrolls to the pricing section, where the plan says what it is.
 */
const proClass =
  "focus-ring inline-flex flex-none items-center rounded-lg bg-accent-solid px-3.5 py-2 " +
  "text-sm font-medium text-on-accent transition-colors duration-200 hover:bg-accent-solid-hover";

export async function Nav() {
  const stars = await fetchStarCount();

  const starsLabel =
    stars === null ? "OpenLimiter on GitHub" : `OpenLimiter on GitHub, ${stars} stars`;

  return (
    /* Symmetric padding, and a row that is the height of its own tallest
       control plus that padding: 64 pixels on a phone, 60 on a desktop. It used
       to open with 64 pixels of padding above the row and none below it, which
       is not a header, it is a gap with links in it. */
    <nav className={`${SHELL} mb-16 py-3`}>
      <header className="flex items-center justify-between gap-3">
        {/* OPTICALLY FLUSH, NOT MERELY MATHEMATICALLY FLUSH.
            The nav and the hero share SHELL, so the lockup's box already starts
            at the same x as the headline: measured 144 at 1440 and 24 at 390,
            both exact. The ring inside that box does not, because its artwork
            sits at x=28 of a 200 unit viewBox, which is 14 percent of clear
            space before any ink. At a 36 pixel mark that is 5 pixels, and 5
            pixels is exactly what reads as the logo being indented. The pull
            below cancels it, so the ink of the mark and the ink of the headline
            share one left edge. */}
        <Link
          href="/"
          aria-label="OpenLimiter, home"
          className="focus-ring -ml-[5px] flex rounded max-[359px]:-ml-[4px]"
        >
          {/* The one instance allowed to play the draw in. See lib/brand.ts.
              It is a step larger on a phone than it used to be: the row is no
              longer competing with five wrapped links, so the mark can be the
              thing it should have been all along. */}
          <BrandLockup
            draw
            markClassName="h-9 w-9 flex-none text-brand max-[359px]:h-8 max-[359px]:w-8"
            wordClassName="text-2xl max-[359px]:text-xl"
          />
        </Link>

        {/* The wide row, unchanged, and only where it genuinely fits on one line. */}
        <div className="hidden flex-wrap items-center justify-end gap-4 lg:flex">
          {links.map((link) => (
            <Link key={link.label} href={link.href} className={linkClass}>
              {link.label}
            </Link>
          ))}
          <a href={SPONSORS_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
            Sponsor
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={starsLabel}
            className={`${linkClass} inline-flex items-center gap-1.5`}
          >
            <GitHubMark className="h-[18px] w-[18px]" />
            {stars !== null && <span className="text-sm">{formatStarCount(stars)}</span>}
          </a>
          <ThemeToggle />
          <Link href="/#pricing" className={proClass}>
            Get Pro
          </Link>
        </div>

        {/* The compact row, everywhere below the large breakpoint. A tablet at 768
            wrapped the wide row into two lines, so the sheet owns that width
            too: two controls beside the mark, and never a third. */}
        <div className="flex items-center gap-2 lg:hidden">
          <Link href="/#pricing" className={proClass}>
            Get Pro
          </Link>
          <NavSheet
            links={links}
            extras={[
              { label: "Sponsor", href: SPONSORS_URL, external: true },
              {
                label: stars === null ? "GitHub" : `GitHub · ${formatStarCount(stars)}`,
                href: REPO_URL,
                external: true,
              },
            ]}
            themeToggle={<ThemeToggle />}
          />
        </div>
      </header>
    </nav>
  );
}
