import { ButtonLink, SectionHeading } from "./ui";
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
 */

const facts = [
  {
    title: "The same engine, in the tab",
    detail:
      "Not a second implementation. The core, the connectors and the adapter are mirrored from the command line tool into the browser bundle, so a reading here and a reading in a terminal cannot disagree.",
  },
  {
    title: "You hand it the document",
    detail:
      "Paste or drop what openlimiter export prints. A browser tab cannot read your disk by itself, and nothing is uploaded to make up for that: parsing happens in the tab and no request leaves it.",
  },
  {
    title: "Installs, and works offline",
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" {...revealGroup}>
        {facts.map((item) => (
          <div
            key={item.title}
            className="lift rounded-xl border border-hairline bg-surface px-5 py-4 hover:border-hairline-strong hover:bg-raised"
            {...reveal}
          >
            <p className="text-sm font-medium text-heading">{item.title}</p>
            <p className="mt-2 text-sm leading-relaxed text-muted">{item.detail}</p>
          </div>
        ))}
      </div>
      <div className="mt-6 flex flex-wrap gap-3" {...reveal}>
        <ButtonLink href="/app" tone="primary">
          Open the web app
        </ButtonLink>
        <ButtonLink href="/docs/cli">How to produce a document</ButtonLink>
      </div>
    </section>
  );
}
