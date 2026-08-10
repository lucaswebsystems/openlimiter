import type { ReactNode } from "react";
import { ButtonLink, IconChip, SectionHeading, SectionPanel } from "./ui";
import { reveal, revealGroup } from "@/lib/motion";

/**
 * The web app, which is live.
 *
 * This section used to say `planned`, and that stopped being true: /app ships
 * the same engine, the same connectors and the same adapter the command line
 * tool uses, mirrored into the browser bundle, and it installs to a home screen
 * through the manifest and service worker in app/app. Every claim below is a
 * property of that route as it stands today.
 *
 * The one thing it is careful not to promise is synchronisation. A browser tab
 * cannot reach into your file system on its own, so the page reads a document
 * you hand it. That is stated rather than glossed over.
 *
 * Presentation: the three facts sit inside one raised panel rather than loose
 * on the canvas, and each leads with a glyph in a tinted chip, so the section
 * reads as an object with a shape instead of three grey boxes.
 */

function BrowserGlyph() {
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
      <rect x="2.75" y="4.25" width="18.5" height="15.5" rx="2.5" />
      <path d="M2.75 8.75h18.5" />
      <path d="M6 6.5h.01M8.5 6.5h.01M11 6.5h.01" />
    </svg>
  );
}

function DropGlyph() {
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
      <path d="M14 2.75H7.5a2 2 0 0 0-2 2v14.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7.25Z" />
      <path d="M13.75 2.9v4.35h4.35" />
      <path d="M12 10.5v6.25m0 0 2.1-2.1M12 16.75l-2.1-2.1" />
    </svg>
  );
}

function BoltGlyph() {
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
      <path d="M13.2 2.5 4.6 13.1a.6.6 0 0 0 .47.98h5.2l-.67 7.42 8.6-10.6a.6.6 0 0 0-.47-.98h-5.2Z" />
    </svg>
  );
}

const facts: readonly { title: string; detail: string; Glyph: () => ReactNode }[] = [
  {
    title: "The same engine, in the tab",
    Glyph: BrowserGlyph,
    detail:
      "Not a second implementation. The core, the connectors and the adapter are mirrored from the command line tool into the browser bundle, so a reading here and a reading in a terminal cannot disagree.",
  },
  {
    title: "You hand it the document",
    Glyph: DropGlyph,
    detail:
      "Paste or drop what openlimiter export prints. A browser tab cannot read your disk by itself, and nothing is uploaded to make up for that: parsing happens in the tab and no request leaves it.",
  },
  {
    title: "Installs, and works offline",
    Glyph: BoltGlyph,
    detail:
      "Add it to a phone or desktop home screen and it opens like an application. A service worker keeps it working with no network at all, because it never needed one.",
  },
];

export function WebApp() {
  return (
    <section id="web-app">
      <SectionHeading
        title="Web app"
        status="live"
        lead="A browser is the one surface every device already has. This one runs the same engine as the command line tool, on a document you give it, with nothing uploaded and no account anywhere."
      />
      <SectionPanel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" {...revealGroup}>
          {facts.map(({ title, detail, Glyph }) => (
            <div
              key={title}
              className="lift elev-1 rounded-xl border border-hairline bg-canvas px-5 py-5 hover:border-hairline-strong hover:bg-raised"
              {...reveal}
            >
              <IconChip>
                <Glyph />
              </IconChip>
              <p className="heading-face mt-3.5 text-sm text-heading">{title}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{detail}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-3" {...reveal}>
          <ButtonLink href="/app" tone="primary">
            Open the web app
          </ButtonLink>
          <ButtonLink href="/docs/cli">How to produce a document</ButtonLink>
        </div>
      </SectionPanel>
    </section>
  );
}
