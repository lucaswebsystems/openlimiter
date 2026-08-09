import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, DocLink, ExternalLink, P } from "@/components/docs/prose";
import { findDocPage } from "@/lib/docs";
import { ISSUES_URL } from "@/lib/site";

const page = findDocPage("/docs/roadmap");

export const metadata: Metadata = {
  title: page?.title,
  description: page?.description,
  alternates: { canonical: "/docs/roadmap" },
};

export default function RoadmapPage() {
  return (
    <DocArticle
      href="/docs/roadmap"
      title="Roadmap"
      lead="What is on this page is not yet built, with one exception noted at the top so nothing here reads as a promise about something that already ships. None of the planned work can be downloaded, bought, or waited for on a list. It is written down so the shape of the project is honest about where it is going."
      sections={[
        {
          id: "not-available",
          title: "Read this first",
          body: (
            <Callout tone="key" title="Planned means not built">
              Everything called planned below does not exist today. There is no mobile application
              in any store and no synchronisation service running anywhere. What works today is
              documented on the rest of this site, and the difference between the two is
              deliberate.
            </Callout>
          ),
        },
        {
          id: "desktop",
          title: "Shipped: the desktop application, on Windows",
          body: (
            <>
              <P>
                A small desktop application with a tray icon next to the system clock, reading the
                same local cache the command line tool writes, so quota is glanceable without a
                terminal open. It is built, and the Windows installer is attached to the release on
                GitHub.
              </P>
              <Bullets
                items={[
                  <>Status: shipped on Windows. The installer is on the releases page.</>,
                  <>
                    Planned: packages for macOS and Linux. Neither is produced yet, so neither can
                    be installed.
                  </>,
                  <>Planned: an automatic update channel. There is none today.</>,
                ]}
              />
            </>
          ),
        },
        {
          id: "mobile",
          title: "Planned: native mobile applications",
          body: (
            <>
              <P>
                Applications for iOS and Android, so a long running window can be checked away from
                the desk. The web app already installs to a phone home screen and works offline,
                which is the part of this that exists.
              </P>
              <Bullets
                items={[
                  <>Status: planned. Nothing is submitted to any store.</>,
                  <>
                    A phone cannot read a file on your laptop, so a native application that shows
                    the numbers on your desk machine depends on the synchronisation work below.
                  </>,
                ]}
              />
            </>
          ),
        },
        {
          id: "sync",
          title: "Planned: encrypted synchronisation",
          body: (
            <>
              <P>
                Encrypted synchronisation of quota state across your own devices. This is the one
                planned capability that would cost money to run, which is why it is also the one
                thing the{" "}
                <DocLink href="/#pricing">paid hosted add on</DocLink> would cover.
              </P>
              <Bullets
                items={[
                  <>Status: planned. No service exists and there is no checkout.</>,
                  <>
                    The local first guarantee does not change: the CLI would keep working with no
                    account and no network.
                  </>,
                ]}
              />
            </>
          ),
        },
        {
          id: "following",
          title: "Following the work",
          body: (
            <P>
              There is no waitlist and no email capture. The honest place to watch is the{" "}
              <ExternalLink href={ISSUES_URL}>issue tracker</ExternalLink>, where the work is
              planned in public.
            </P>
          ),
        },
      ]}
    />
  );
}
