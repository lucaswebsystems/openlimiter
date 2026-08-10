import { getTranslations } from "next-intl/server";
import { BrandLockup } from "./brand";
import { HeaderState } from "./header-state";
import { NavSheet } from "./nav-sheet";
import { SiteLink } from "./site-link";
import { ThemeToggle } from "./theme-toggle";
import { GitHubMark, SHELL } from "./ui";
import { fetchStarCount, formatStarCount } from "@/lib/github";
import { REPO_URL, SPONSORS_URL } from "@/lib/site";

/**
 * The header, the pattern's split personality (founder's order, 2026-08-10).
 *
 * Over the fold it is NO BAR AT ALL: a transparent row floating on the
 * footage in the dark island treatment, white wordmark, white links, with the
 * fold's own top scrim carrying the legibility. Past the fold it is a sticky
 * frosted bar in the page's theme, translucent canvas over a backdrop blur
 * with a hairline underneath. While any part of the fold is still under the
 * bar, the bar stays dark whatever the theme. The three treatments are drawn
 * by CSS from one attribute (see globals.css, THE STICKY HEADER'S GLASS),
 * written by the HeaderState watcher from IntersectionObservers, never a
 * scroll listener. Pages without a fold get the frosted themed bar from
 * their first paint, before any script, through the `body:not(:has())` arm.
 *
 * The header itself never animates a colour: the frosted coats are absolute
 * layers behind the content and only their opacity changes, which is the
 * pattern's cure for repainting a blurred, viewport wide strip every frame of
 * the first scroll.
 *
 * ONE ROW, MEASURED
 * -----------------
 * The row is the height of the bar by declaration rather than by the sum of
 * its padding: 56 pixels where the sheet trigger sets the tallest control, 52
 * where the desktop controls do, the same 52 to 56 band the bar has always
 * measured at, now written once as --ol-header-h and read by the sticky bar,
 * this row, the fold's pull under it and the anchor scroll offset alike.
 * Centring stays by rule: the row is a flex line with items-center, and the
 * wordmark keeps `leading-none` so the box being centred is the glyph's own.
 *
 * TWO LAYOUTS, AND NEITHER OF THEM WRAPS
 * --------------------------------------
 * The wide row is the row it always was, and below the large breakpoint the
 * links move into the disclosure sheet, leaving one tight line: the mark, Get
 * Pro, and the button that opens the rest. The sheet is a fixed overlay, so
 * it works identically over the footage and over the frosted bar.
 *
 * The star count comes from the GitHub API at render time and is cached for
 * an hour. When that request cannot be trusted the chip renders as a plain
 * link with no number: see lib/github.ts.
 */

/**
 * The header links.
 *
 * Blog is not among them any more. The route is alive and the footer still
 * carries it, but a header is a list of the things a first visit needs, and one
 * post does not earn a slot beside the download.
 *
 * The hrefs are the unprefixed English routes, always. `SiteLink` puts the
 * locale on the four that have one and leaves `/app` alone, which is an English
 * only tree and would 404 behind a prefix.
 */
const routes = [
  { key: "docs", href: "/docs" },
  { key: "webApp", href: "/app" },
  { key: "download", href: "/download" },
  { key: "changelog", href: "/changelog" },
] as const;

/* `hdr-ink` is the marker globals.css uses to lift this quiet grey to the
   full heading white while the header is in its dark treatment over the
   footage: a muted step has no contrast of its own on a moving picture. */
const linkClass =
  "hdr-ink focus-ring rounded text-sm text-muted transition-colors duration-200 hover:text-heading";

/**
 * The one filled control in the header, and it goes to the price on this page.
 *
 * It is not a checkout, because there is no checkout: nothing here takes money
 * yet, and a button that looked like it did would be the first untrue thing on
 * the site. It scrolls to the pricing section, where the plan says what it is.
 * Solid in both header states, so it never turns into a ghost over footage.
 */
const proClass =
  "focus-ring inline-flex flex-none items-center rounded-lg bg-accent-solid px-3.5 py-2 " +
  "text-sm font-medium text-on-accent transition-colors duration-200 hover:bg-accent-solid-hover";

export async function Nav() {
  const stars = await fetchStarCount();
  const t = await getTranslations("nav");
  const routeLabels = await getTranslations("common.routes");
  const common = await getTranslations("common");

  const links = routes.map((route) => ({ label: routeLabels(route.key), href: route.href }));

  const starsLabel =
    stars === null ? t("githubAria") : t("githubStarsAria", { count: stars });

  return (
    /* suppressHydrationWarning for the same reason the root <html> carries it:
       a pre paint inline script (the fold's sync script) writes `data-bar`
       onto this element before React hydrates, exactly like the theme arm
       script writes `data-theme` on the root. The attribute is state, owned
       by that script and the HeaderState watcher, never rendered by React. */
    <header className="site-header mb-16" suppressHydrationWarning>
      <HeaderState />
      {/* The glass, three layers, opacity only. See globals.css. */}
      <span className="hdr-layers" aria-hidden="true">
        <span className="hdr-blur" />
        <span className="hdr-tint-page" />
        <span className="hdr-tint-dark" />
      </span>

      <div className="site-header-scope relative">
        <div className={SHELL}>
          <div className="site-header-row flex items-center justify-between gap-3">
            {/* OPTICALLY FLUSH, NOT MERELY MATHEMATICALLY FLUSH.
                The header and the fold share SHELL, so the lockup's box already
                starts at the same x as the headline. The ring inside that box
                does not, because its artwork sits at x=28 of a 200 unit
                viewBox, which is 5 pixels of clear space at a 36 pixel mark,
                and 5 pixels is exactly what reads as the logo being indented.
                The pull below cancels it. */}
            <SiteLink
              href="/"
              aria-label={common("homeAria")}
              className="focus-ring -ml-[5px] flex items-center rounded max-[359px]:-ml-[4px]"
            >
              {/* The one instance allowed to play the draw in. See lib/brand.ts.
                  The wordmark carries `leading-none` so flex centres the
                  glyph's own box rather than a taller line box; the row above
                  fixes the bar height, and the two rules together are what
                  keeps the centring measured rather than coincidental. */}
              <BrandLockup
                draw
                markClassName="h-9 w-9 flex-none text-brand max-[359px]:h-8 max-[359px]:w-8"
                wordClassName="text-2xl leading-none max-[359px]:text-xl"
              />
            </SiteLink>

            {/* The wide row, only where it genuinely fits on one line. */}
            <div className="hidden flex-wrap items-center justify-end gap-4 lg:flex">
              {links.map((link) => (
                <SiteLink key={link.href} href={link.href} className={linkClass}>
                  {link.label}
                </SiteLink>
              ))}
              <a
                href={SPONSORS_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                {t("sponsor")}
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
              <SiteLink href="/#pricing" className={proClass}>
                {t("getPro")}
              </SiteLink>
            </div>

            {/* The compact row, everywhere below the large breakpoint. A tablet
                at 768 wrapped the wide row into two lines, so the sheet owns
                that width too: two controls beside the mark, and never a third. */}
            <div className="flex items-center gap-2 lg:hidden">
              <SiteLink href="/#pricing" className={proClass}>
                {t("getPro")}
              </SiteLink>
              <NavSheet
                links={links}
                extras={[
                  { label: t("sponsor"), href: SPONSORS_URL, external: true },
                  {
                    label: stars === null ? "GitHub" : `GitHub · ${formatStarCount(stars)}`,
                    href: REPO_URL,
                    external: true,
                  },
                ]}
                themeToggle={<ThemeToggle />}
              />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
