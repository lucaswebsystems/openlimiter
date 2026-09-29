import { useTranslations } from "next-intl";
import { SiteLink } from "./site-link";
import { heroMarks, toolTitle } from "./tool-marks";
import { ButtonLink, SHELL } from "./ui";

/** Centered introduction and platform actions, followed by the real product capture. */
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

  const inner = (
    <>
      {/* The header watcher's top marker: exactly one bar height tall, pinned
          to the fold's top, sized by the same token as the bar itself. While
          any part of it is on screen the header is within the top scrim's
          protected band and stays transparent; once it scrolls away the
          frosted dark coat takes over. Its height follows the token across
          the breakpoint, so the boundary can never go stale. */}
      <div aria-hidden="true" className="hero-fold-sentinel" />

      <div className="relative z-10 pt-[calc(var(--ol-header-h)+var(--ol-space-7))] pb-[var(--ol-space-6)]">
        <div className={`${SHELL} w-full text-center`}>
          <div>
            <h1 className="fold-enter fold-enter-title text-3xl font-medium leading-tight tracking-tight text-heading sm:text-4xl lg:text-5xl">
              {/* One flowing paragraph on a phone, two measured lines from the
                 large breakpoint: the founder wants three lines on mobile, not
                 a hard break that costs five. */}
              <span className="lg:block">
                {t.rich("title.limits", {
                  accent: (chunks) => <span className="text-brand">{chunks}</span>,
                })}
              </span>{" "}
              <span className="lg:block">
                {t.rich("title.route", {
                  accent: (chunks) => <span className="text-brand">{chunks}</span>,
                })}
              </span>
            </h1>

            <p className="fold-enter fold-enter-lead mx-auto mt-[var(--ol-space-5)] max-w-2xl text-lg leading-relaxed text-body">
              {t("lead")}
            </p>

            {/* Three rows, seven buttons, every one carrying its monochrome
               glyph, the founder's list (2026-08-13): the three desktop
               downloads on the first line, the two phone installs on the
               second, the terminal with the blue web app beside it on the
               third, and nothing else. */}
            <div className="fold-enter fold-enter-row mx-auto mt-[var(--ol-space-6)] max-w-3xl space-y-[var(--ol-space-3)]">
              {/* A phone gets the three paths a phone can take, the founder's
                 order (2026-08-11): the web app and the two install guides.
                 The desktop platforms and the terminal appear from the large
                 breakpoint, where they mean something. Separate rows per
                 breakpoint rather than utility overrides on one row, because
                 a display utility on a button fights the button's own. */}
              <div className="hidden grid-cols-3 gap-[var(--ol-space-3)] lg:grid">
                <ButtonLink href="/download#windows" tone="solid" className="min-h-11 gap-2 !text-[var(--ol-fixed-dark-on-accent)]" label={t("rows.windows")}>
                  <WindowsGlyph />
                  {t("rows.windows")}
                </ButtonLink>
                <ButtonLink href="/download#macos" tone="solid" className="min-h-11 gap-2 !text-[var(--ol-fixed-dark-on-accent)]" label={t("rows.macos")}>
                  <AppleGlyph />
                  {t("rows.macos")}
                </ButtonLink>
                <ButtonLink href="/download#linux" tone="solid" className="min-h-11 gap-2 !text-[var(--ol-fixed-dark-on-accent)]" label={t("rows.linux")}>
                  <LinuxGlyph />
                  {t("rows.linux")}
                </ButtonLink>
              </div>
              <div className="flex flex-wrap justify-center gap-[var(--ol-space-3)]">
                <ButtonLink href="/app" tone="solid" className="h-11 gap-2 whitespace-nowrap !border-transparent !bg-accent-solid !text-on-accent hover:!bg-accent-solid-hover lg:hidden" label={t("rows.webApp")}>
                  <GlobeGlyph />
                  {t("rows.webApp")}
                </ButtonLink>
                <ButtonLink href="/download#iphone" tone="solid" className="min-h-11 gap-2 !text-[var(--ol-fixed-dark-on-accent)]" label={t("rows.iphone")}>
                  <IphoneGlyph />
                  {t("rows.iphone")}
                </ButtonLink>
                <ButtonLink href="/download#android" tone="solid" className="min-h-11 gap-2 !text-[var(--ol-fixed-dark-on-accent)]" label={t("rows.android")}>
                  <AndroidGlyph />
                  {t("rows.android")}
                </ButtonLink>
              </div>
              <div className="hidden grid-cols-2 gap-[var(--ol-space-3)] lg:grid">
                <ButtonLink href="/download#npm" tone="solid" className="min-h-11 gap-2 !text-[var(--ol-fixed-dark-on-accent)]" label={t("rows.cli")}>
                  <TerminalGlyph />
                  {t("rows.cli")}
                </ButtonLink>
                <ButtonLink href="/app" tone="solid" className="h-11 gap-2 whitespace-nowrap !border-transparent !bg-accent-solid !text-on-accent hover:!bg-accent-solid-hover" label={t("rows.webApp")}>
                  <GlobeGlyph />
                  {t("rows.webApp")}
                </ButtonLink>
              </div>
            </div>

          </div>
        </div>
      </div>

      <div className="relative z-10 pb-[var(--ol-space-6)]">
        <div className={SHELL}>
          <div className="fold-enter fold-enter-marks flex flex-wrap items-center justify-center gap-[var(--ol-space-4)] text-center">
            <span className="text-xs text-body">{t("supports.label")}</span>
            <div className="flex flex-wrap items-center justify-center gap-[var(--ol-space-4)]">
              {heroMarks.map((tool) => (
                <span
                  key={tool.name}
                  title={toolTitle(tool, tToolTitle)}
                  className="inline-flex items-center justify-center text-heading"
                >
                  <tool.Mark className="h-6 w-6" />
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
    </>
  );

  return (
    <section className="hero-fold hero-dark-island w-full bg-canvas" style={{ minHeight: "auto" }}>
      {/* Runs at parse time, before the header can paint. See the note above. */}
      <script dangerouslySetInnerHTML={{ __html: FOLD_SYNC_SCRIPT }} />
      {inner}
    </section>
  );
}
