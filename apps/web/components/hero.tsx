import { useTranslations } from "next-intl";
import { preload } from "react-dom";
import { HeroFoldMedia } from "./hero-backdrop";
import { SiteLink } from "./site-link";
import { heroMarks, toolTitle } from "./tool-marks";
import { ButtonLink, SHELL } from "./ui";
import { HERO_BACKDROP_ENABLED } from "@/lib/site";

/**
 * The first fold, the full Perpeta pattern (founder's order, 2026-08-10).
 *
 * The whole fold is the footage: 100svh, full width, a dark island in both
 * themes, with the copy sitting left and vertically centred over it. Two
 * measured scrims carry the legibility, the lateral curtain for the copy and
 * the top scrim for the header zone; both live in globals.css with the
 * numbers that closed them. The sticky header floats transparent over all of
 * it, which is why this section pulls itself up under the header's flow slot.
 *
 * NO GREY AND NO ALPHA IN THE FOLD, on purpose. Alpha has no contrast of its
 * own (it depends on the frame passing behind it), and the site's muted grey
 * would need a near opaque scrim to reach AA over footage. So the title, the
 * lead, the disclaimer, the links and the supports row all ride the same near
 * white, and SIZE alone carries the hierarchy. That is the pattern's own
 * rule, kept whole.
 *
 * No button in the fold is transparent either: a ghost outline over a moving
 * picture is whatever the frame behind it says it is. The primary keeps its
 * white solid; everything else sits on a solid surface fill.
 *
 * Nine targets, honestly. Desktop platforms, mobile install guides and npm go
 * to their rows on the download page. The web app is a route on this site,
 * GitHub is the repository, and the docs stay on this site. The mobile labels
 * describe installation without claiming that a store app exists. The line
 * under the rows says the rest in the open, including that the desktop builds
 * are not code signed yet.
 *
 * The entrance runs on the fold-enter CSS classes rather than the scroll
 * reveal system: the title and lead are born visible and animate transform
 * only, so the fold's largest paint never waits for hydration.
 */

function WindowsGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M3 5.4 10.6 4.3v7.2H3V5.4Zm0 13.2 7.6 1.1v-7.1H3v6Zm8.7 1.3L21 21V12.6h-9.3v7.3Zm0-15.8v7.4H21V3l-9.3 1.1Z" />
    </svg>
  );
}

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M16.36 12.72c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3.01-.79-1.55.02-2.98.9-3.77 2.29-1.61 2.79-.41 6.92 1.15 9.18.77 1.11 1.68 2.35 2.87 2.3 1.15-.05 1.59-.74 2.98-.74 1.39 0 1.78.74 3 .72 1.24-.02 2.02-1.12 2.78-2.24.88-1.28 1.24-2.53 1.26-2.6-.03-.01-2.4-.92-2.42-3.69ZM14.1 5.98c.63-.77 1.06-1.83.94-2.9-.91.04-2.02.61-2.67 1.37-.58.68-1.09 1.77-.95 2.81 1.02.08 2.05-.52 2.68-1.28Z" />
    </svg>
  );
}

/** A minimal Tux silhouette, drawn here, monochrome like every mark. */
function LinuxGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.8c-2.5 0-3.8 2-3.8 4.3 0 1.6-.5 2.9-1.3 4.2-1 1.7-1.8 3.4-1.8 5.1 0 2.8 2.3 4.4 6.9 4.4s6.9-1.6 6.9-4.4c0-1.7-.8-3.4-1.8-5.1-.8-1.3-1.3-2.6-1.3-4.2 0-2.3-1.3-4.3-3.8-4.3Z" />
      <path d="M9.9 7.1v.01M14.1 7.1v.01" strokeWidth="2.3" />
      <path d="M10.7 9.3c.5.5 2.1.5 2.6 0" />
    </svg>
  );
}

export function GlobeGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5s-1.1 6.1-3.3 8.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z" />
    </svg>
  );
}

/** A phone with the top island: the iPhone the web app installs onto. */
function IphoneGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6.8" y="2.6" width="10.4" height="18.8" rx="2.8" />
      <path d="M10.4 5.2h3.2" />
    </svg>
  );
}

/** The robot head outline, no storefront anywhere in it. */
function AndroidGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.6 16.4a7.4 7.4 0 0 1 14.8 0Z" />
      <path d="m7.6 7.8-1.4-2.2M16.4 7.8l1.4-2.2" />
      <path d="M9.3 12.9v.01M14.7 12.9v.01" strokeWidth="2.4" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 6 5 6-5 6M12 18h8" />
    </svg>
  );
}

/**
 * THE HEADER'S PRE HYDRATION SYNC, one inline script in the fold itself.
 *
 * The server cannot know where a visitor's scroll will be restored, so it
 * emits no data-bar and CSS defaults the header to the safe frosted themed
 * bar. This script runs the moment the fold's opening tag is parsed, before
 * the first paint that could include the header, and writes the real state
 * from real geometry: the same three values, the same boundaries, that
 * components/header-state.tsx computes after hydration. It also keeps the
 * value honest through the browser's scroll restoration with a passive scroll
 * listener that exists ONLY until HeaderState mounts and takes over with its
 * observers: the steady state design has no scroll listener, this is the
 * bridge across the pre hydration gap and nothing more.
 *
 * It lives in the Hero rather than in the document head on purpose: a head
 * script cannot see the header or the fold (the body is not parsed yet), and
 * only a page that renders the fold needs any of this. Pages without a fold
 * are correct from the stylesheet alone.
 */
const FOLD_SYNC_SCRIPT = [
  "(function(){try{",
  'var h=document.querySelector(".site-header");',
  'var f=document.querySelector(".hero-fold");',
  "if(!h||!f)return;",
  "var set=function(){",
  "if(window.innerWidth<1024){h.removeAttribute('data-bar');return;}",
  "var r=f.getBoundingClientRect();",
  "var b=h.getBoundingClientRect().height||56;",
  'h.setAttribute("data-bar",r.bottom<=0?"page":(r.top>-b?"none":"dark"));',
  "};",
  "set();",
  "var on=function(){set()};",
  'addEventListener("scroll",on,{passive:true});',
  'window.__olFoldPreSync=function(){removeEventListener("scroll",on);try{delete window.__olFoldPreSync}catch(e){}};',
  "}catch(e){}})();",
].join("");

export function Hero() {
  const t = useTranslations("hero");
  /* toolTitle's hover text lives in its own namespace, shared with every
     surface that renders a tool mark, so this is a translator for the
     `tools.title` catalog entries rather than for `hero` itself. */
  const tToolTitle = useTranslations("tools.title");

  /* The poster would otherwise be discovered only when the stylesheet lays
     the media layer out, which measured 991 to 1491ms into the load. The
     preload puts the request in the document head with high priority, so the
     fold's first frame is on the wire before the CSS has finished parsing. */
  if (HERO_BACKDROP_ENABLED) {
    preload("/backdrop/hero-backdrop.jpg", { as: "image", fetchPriority: "high" });
  }

  /* Everything between the media layer and the pause control, in reading
     order. It is handed to the media component as children so the pause
     control can sit AFTER the fold's links and buttons in the DOM: a keyboard
     reaches the headline, the downloads and the two links first, and the
     pill last, whatever the pill's visual position. Paint order is untouched:
     the media layer has no z-index, the copy block sits at z-10, the pill at
     z-20. */
  const inner = (
    <>
      {/* The header watcher's top marker: exactly one bar height tall, pinned
          to the fold's top, sized by the same token as the bar itself. While
          any part of it is on screen the header is within the top scrim's
          protected band and stays transparent; once it scrolls away the
          frosted dark coat takes over. Its height follows the token across
          the breakpoint, so the boundary can never go stale. */}
      <div aria-hidden="true" className="hero-fold-sentinel" />
      <div aria-hidden="true" className="hero-scrim-side" />
      <div aria-hidden="true" className="hero-scrim-top" />

      {/* The centering box excludes the header's band: the bar floats OVER the
          fold, so content centered in the full height can rise underneath it on
          a small screen, which put the headline behind the controls the day the
          bar grew. Reserving the bar's own height plus a small gap above (and a
          matching breath below) keeps the centre optically where it was while
          making the collision impossible at any viewport. */}
      <div className="relative z-10 flex h-full items-center pb-4 pt-[calc(var(--ol-header-h)+0.5rem)]">
        <div className={`${SHELL} w-full`}>
          <div className="max-w-2xl">
            <h1 className="fold-enter fold-enter-title text-4xl font-medium leading-tight tracking-tight text-heading sm:text-5xl lg:text-6xl">
              {t.rich("title.limits", {
                accent: (chunks) => <span className="text-accent">{chunks}</span>,
              })}
              <br />
              {t.rich("title.route", {
                accent: (chunks) => <span className="text-accent">{chunks}</span>,
              })}
            </h1>

            <p className="fold-enter fold-enter-lead mt-6 max-w-xl text-lg leading-relaxed text-body">
              {t("lead")}
            </p>

            {/* Two rows, seven buttons, every one carrying its monochrome
               glyph, the founder's exact list (2026-08-11): three desktop
               downloads and the blue web app on the first line, the three
               install paths on the second, and nothing else. */}
            <div className="fold-enter fold-enter-row mt-9 space-y-3">
              <div className="flex flex-wrap gap-3">
                <ButtonLink
                  href="/download#windows"
                  tone="primary"
                  className="h-11 gap-2 whitespace-nowrap"
                  label={t("rows.windows")}
                >
                  <WindowsGlyph />
                  {t("rows.windows")}
                </ButtonLink>
                <ButtonLink
                  href="/download#macos"
                  tone="solid"
                  className="h-11 gap-2 whitespace-nowrap"
                  label={t("rows.macos")}
                >
                  <AppleGlyph />
                  {t("rows.macos")}
                </ButtonLink>
                <ButtonLink
                  href="/download#linux"
                  tone="solid"
                  className="h-11 gap-2 whitespace-nowrap"
                  label={t("rows.linux")}
                >
                  <LinuxGlyph />
                  {t("rows.linux")}
                </ButtonLink>
                <ButtonLink
                  href="/app"
                  tone="solid"
                  className="h-11 gap-2 whitespace-nowrap !border-transparent !bg-accent-solid !text-on-accent hover:!bg-accent-solid-hover"
                  label={t("rows.webApp")}
                >
                  <GlobeGlyph />
                  {t("rows.webApp")}
                </ButtonLink>
              </div>
              <div className="flex flex-wrap gap-3">
                <ButtonLink
                  href="/download#iphone"
                  tone="solid"
                  className="h-11 gap-2 whitespace-nowrap"
                  label={t("rows.iphone")}
                >
                  <IphoneGlyph />
                  {t("rows.iphone")}
                </ButtonLink>
                <ButtonLink
                  href="/download#android"
                  tone="solid"
                  className="h-11 gap-2 whitespace-nowrap"
                  label={t("rows.android")}
                >
                  <AndroidGlyph />
                  {t("rows.android")}
                </ButtonLink>
                <ButtonLink
                  href="/download#npm"
                  tone="solid"
                  className="h-11 gap-2 whitespace-nowrap"
                  label={t("rows.cli")}
                >
                  <TerminalGlyph />
                  {t("rows.cli")}
                </ButtonLink>
              </div>
            </div>

            <div className="fold-enter fold-enter-note space-y-1.5 pt-4">
              <p className="max-w-xl text-xs leading-relaxed text-body">{t("disclaimer")}</p>
              <SiteLink
                href="/download"
                className="focus-ring inline-block rounded text-sm text-heading underline decoration-1 underline-offset-4 transition-colors hover:text-accent"
              >
                {t("downloads.allOptions")}
              </SiteLink>
            </div>

            <div className="fold-enter fold-enter-marks flex flex-wrap items-center gap-2 pt-7">
              <span className="text-xs text-body">{t("supports.label")}</span>
              <div className="flex items-center gap-3">
                {heroMarks.map((tool) => (
                  <span
                    key={tool.name}
                    title={toolTitle(tool, tToolTitle)}
                    className="inline-flex items-center justify-center text-heading"
                  >
                    <tool.Mark className="h-[18px] w-[18px]" />
                    <span className="sr-only">{toolTitle(tool, tToolTitle)}</span>
                  </span>
                ))}
              </div>
              <SiteLink
                href="/docs/providers"
                className="focus-ring rounded text-xs text-heading underline decoration-1 underline-offset-4 transition-colors hover:text-accent"
              >
                {t("supports.manualEntry")}
              </SiteLink>
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <section className="hero-fold hero-dark-island w-full">
      {/* Runs at parse time, before the header can paint. See the note above. */}
      <script dangerouslySetInnerHTML={{ __html: FOLD_SYNC_SCRIPT }} />
      {/* The one flag from lib/site.ts switches the footage alone: with it
          off, the fold is the same dark island on its plain canvas, and no
          poster, video or pause control reaches the page. */}
      {HERO_BACKDROP_ENABLED ? (
        <HeroFoldMedia playLabel={t("backdrop.play")} pauseLabel={t("backdrop.pause")}>
          {inner}
        </HeroFoldMedia>
      ) : (
        inner
      )}
    </section>
  );
}
