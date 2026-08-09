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
      lead="Everything on this page is planned and not yet built. None of it can be downloaded, bought, or waited for on a list. It is written down so the shape of the project is honest about where it is going."
      sections={[
        {
          id: "not-available",
          title: "Read this first",
          body: (
            <Callout tone="key" title="Planned means not built">
              Nothing below exists today. There is no desktop application to install, no mobile
              application in any store, and no synchronisation service running anywhere. What
              works today is documented on the rest of this site, and the difference between the
              two is deliberate.
            </Callout>
          ),
        },
        {
          id: "desktop",
          title: "Planned: a desktop application",
          body: (
            <>
              <P>
                A small desktop application with a tray icon next to the system clock on Windows,
                macOS, and Linux, so quota is glanceable without a terminal open.
              </P>
              <Bullets
                items={[
                  <>Status: planned. No build exists.</>,
                  <>It would read the same local cache the CLI already writes.</>,
                ]}
              />
            </>
          ),
        },
        {
          id: "mobile",
          title: "Planned: mobile applications",
          body: (
            <>
              <P>
                Applications for iOS and Android, so a long running window can be checked away from
                the desk.
              </P>
              <Bullets
                items={[
                  <>Status: planned. Nothing is submitted to any store.</>,
                  <>
                    A phone cannot read a file on your laptop, so this depends on the
                    synchronisation work below.
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
