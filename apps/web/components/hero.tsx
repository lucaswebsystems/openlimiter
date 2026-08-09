import Link from "next/link";
import { providerMarks } from "./provider-marks";
import { ButtonLink, IconButtonLink, SHELL } from "./ui";
import { DOWNLOAD_DISCLAIMER } from "@/lib/downloads";
import { reveal } from "@/lib/motion";
import { RELEASES_LATEST_URL } from "@/lib/site";

/**
 * The hero.
 *
 * Left aligned, 48 pixel medium headline on two lines, a two line lead capped
 * at 512 pixels, one row of buttons, the honest line about what those buttons
 * actually reach, and the row of provider marks.
 *
 * Each button leads to the thing it names, and only where that thing exists.
 * Windows goes to the packaged installer on the releases page and the globe
 * opens the web app, because both are real. The two mobile buttons lead to the
 * download page rather than to a store, because there is nothing in a store,
 * and each says so in its accessible name. The line under the row says the same
 * thing in the open.
 */

function AppleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
      <path d="M16.36 12.72c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3.01-.79-1.55.02-2.98.9-3.77 2.29-1.61 2.79-.41 6.92 1.15 9.18.77 1.11 1.68 2.35 2.87 2.3 1.15-.05 1.59-.74 2.98-.74 1.39 0 1.78.74 3 .72 1.24-.02 2.02-1.12 2.78-2.24.88-1.28 1.24-2.53 1.26-2.6-.03-.01-2.4-.92-2.42-3.69ZM14.1 5.98c.63-.77 1.06-1.83.94-2.9-.91.04-2.02.61-2.67 1.37-.58.68-1.09 1.77-.95 2.81 1.02.08 2.05-.52 2.68-1.28Z" />
    </svg>
  );
}

function PlayGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 3.2v17.6a.8.8 0 0 0 1.22.68l14.3-8.8a.8.8 0 0 0 0-1.36L5.22 2.52A.8.8 0 0 0 4 3.2Z" />
      <path d="m4.4 2.9 10.4 10.4M4.4 21.1 14.8 10.7" strokeLinecap="round" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
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

function GlobeGlyph() {
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

function WindowsGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
      <path d="M3 5.4 10.6 4.3v7.2H3V5.4Zm0 13.2 7.6 1.1v-7.1H3v6Zm8.7 1.3L21 21V12.6h-9.3v7.3Zm0-15.8v7.4H21V3l-9.3 1.1Z" />
    </svg>
  );
}

export function Hero() {
  return (
    <section className={`${SHELL} pb-10 md:pb-12`}>
      <div className="space-y-6" {...reveal}>
        <h1 className="text-3xl font-medium tracking-tight text-heading md:text-5xl">
          Know your limits.
          <br />
          Route around them.
        </h1>
        <p className="max-w-lg text-lg leading-relaxed text-soft">
          Read your AI subscription quota locally. Give agents bounded budget state and advice.
          Open source, local first, cross platform.
        </p>
      </div>

      <div className="pt-10" {...reveal}>
        <div className="flex flex-row flex-wrap gap-3">
          <ButtonLink
            href={RELEASES_LATEST_URL}
            tone="primary"
            external
            label="Download the Windows installer from the releases page on GitHub"
          >
            <WindowsGlyph />
            Download for Windows
          </ButtonLink>
          <ButtonLink href="/app" tone="ghost" label="Open the web app, live now">
            <GlobeGlyph />
            Open the web app
          </ButtonLink>
          <IconButtonLink href="/download#ios" label="iOS, not built, see the download page">
            <AppleGlyph />
          </IconButtonLink>
          <IconButtonLink href="/download#android" label="Android, not built, see the download page">
            <PlayGlyph />
          </IconButtonLink>
          <IconButtonLink href="/download#source" label="Command line tool, available now">
            <TerminalGlyph />
          </IconButtonLink>
        </div>

        <div className="space-y-1 pt-3">
          <p className="max-w-lg text-xs leading-relaxed text-muted">{DOWNLOAD_DISCLAIMER}</p>
          <Link
            href="/download"
            className="focus-ring inline-block rounded text-sm text-muted transition-colors hover:text-heading"
          >
            All download options
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-6">
          <span className="text-xs text-muted">Supports</span>
          <div className="flex items-center gap-1">
            {providerMarks.map(({ name, Mark }) => (
              <span
                key={name}
                className="inline-flex items-center justify-center rounded-full p-1.5 text-muted"
              >
                <Mark />
              </span>
            ))}
          </div>
          <Link
            href="/docs/providers"
            className="focus-ring rounded text-xs text-muted transition-colors hover:text-heading"
          >
            and manual entry
          </Link>
        </div>
      </div>
    </section>
  );
}
