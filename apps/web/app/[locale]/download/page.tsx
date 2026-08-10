import type { Metadata } from "next";
import Link from "next/link";
import { PageShell, ShellSections } from "@/components/page-shell";
import { ButtonLink, Chip } from "@/components/ui";
import { DOWNLOAD_DISCLAIMER, downloadTargets, type DownloadTarget } from "@/lib/downloads";
import { reveal, revealGroup } from "@/lib/motion";
import { RELEASES_URL, REPO_URL, SITE_URL } from "@/lib/site";

/**
 * /download
 *
 * One row per way of getting OpenLimiter, read straight from lib/downloads.ts,
 * so a platform cannot be advertised here and missing from the hero or the
 * footer. Each row keeps its own id, which is what the footer's deep links and
 * /download#windows land on.
 *
 * The page is in three parts, and the parts are the ship states themselves:
 * what a reader can use today, what is built but not packaged for them yet, and
 * what does not exist. A command and a download control render only for a row
 * that is already available, and that is checked here rather than trusted from
 * the data, so a row that gains either before it ships still cannot be made to
 * look installable. The middle section renders only when something is actually
 * in that state, so the page never carries a heading with nothing under it.
 *
 * A platform with several packaged files lists every one of them, pointing at
 * the artifact itself rather than at a releases page the reader then has to
 * read. The caveat that comes with an unsigned build renders under those
 * controls, never instead of them.
 */

export const metadata: Metadata = {
  title: "Download",
  description:
    "Get OpenLimiter: packaged desktop builds for Windows, macOS and Linux, the command line tool from npm, or the web app in any browser. Mobile applications are not built.",
  alternates: { canonical: "/download" },
};

const available = downloadTargets.filter((target) => target.state === "available");
const building = downloadTargets.filter((target) => target.state === "in development");
const notBuilt = downloadTargets.filter((target) => target.state === "planned");

function TargetCard({ target }: { target: DownloadTarget }) {
  /* The one rule this page exists to keep. Anything that is not available today
     gets no command and no download control, whatever the data happens to
     carry. */
  const shipped = target.state === "available";
  const command = shipped ? target.command : undefined;
  const href = shipped ? target.href : undefined;
  const assets = shipped ? target.assets : undefined;

  return (
    <article
      id={target.id}
      className="lift scroll-mt-8 rounded-xl border border-hairline bg-surface p-6 hover:border-hairline-strong hover:bg-raised"
      {...reveal}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xl font-medium text-heading">{target.name}</h3>
        <Chip tone={shipped ? "accent" : "neutral"}>{target.state}</Chip>
      </div>

      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{target.summary}</p>

      {assets !== undefined && assets.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {assets.map((asset) => (
            <ButtonLink
              key={asset.href}
              href={asset.href}
              tone={asset.primary === true ? "primary" : "ghost"}
              external
            >
              {asset.label}
            </ButtonLink>
          ))}
        </div>
      )}

      {target.note !== undefined && (
        <p className="mt-3 max-w-2xl text-xs leading-relaxed text-muted">{target.note}</p>
      )}

      {href !== undefined && target.hrefLabel !== undefined && (
        <div className="mt-4">
          <ButtonLink href={href} tone="primary" external={target.hrefExternal === true}>
            {target.hrefLabel}
          </ButtonLink>
        </div>
      )}

      {command !== undefined && (
        <pre className="mt-4 overflow-x-auto rounded-lg border border-hairline bg-code p-4 font-mono text-2xs leading-6 text-soft">
          <code>{command}</code>
        </pre>
      )}

      {command !== undefined && target.requirement !== undefined && (
        <p className="mt-3 text-xs text-muted">{target.requirement}</p>
      )}
    </article>
  );
}

const linkClass = "focus-ring rounded text-accent transition-colors hover:text-accent-hover";

export default function DownloadPage() {
  return (
    <PageShell title="Download" lead={DOWNLOAD_DISCLAIMER}>
      <ShellSections>
        <section>
          <h2 className="text-2xl font-medium text-heading" {...reveal}>
            Available now
          </h2>
          <p className="mt-2 max-w-2xl text-base text-muted" {...reveal}>
            Windows, macOS and Linux each have a packaged desktop build, and every link below goes
            straight to the file. The command line tool is one npm install on any of them, or one
            clone if you would rather build it, because it is plain Node.js with no third party
            runtime dependencies. The web app needs nothing installed at all.
          </p>
          <div className="mt-8 space-y-4" {...revealGroup}>
            {available.map((target) => (
              <TargetCard key={target.id} target={target} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-medium text-heading" {...reveal}>
            On your phone
          </h2>
          <p className="mt-2 max-w-2xl text-base text-muted" {...reveal}>
            This installs the web app to your home screen. No native iOS or Android
            application is built.
          </p>
          <div
            className="mt-8 flex flex-col items-start gap-5 rounded-xl border border-hairline bg-surface p-6 sm:flex-row sm:items-center"
            {...reveal}
          >
            <span className="flex-none overflow-hidden rounded-lg border border-hairline">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/qr/openlimiter-app.svg"
                alt={`QR code linking to ${SITE_URL}/app`}
                width={180}
                height={180}
                className="block h-[180px] w-[180px]"
              />
            </span>
            <p className="text-sm leading-relaxed text-muted">
              Scan this with your phone&apos;s camera. The web app opens, and you install it to
              the home screen from there.
            </p>
          </div>
        </section>

        {building.length > 0 && (
          <section>
            <h2 className="text-2xl font-medium text-heading" {...reveal}>
              Built, not packaged for you yet
            </h2>
            <p className="mt-2 max-w-2xl text-base text-muted" {...reveal}>
              This exists and it runs. What is missing is a build you can install on your own
              platform, and until that is produced this section says so rather than pointing you at
              something that is not there.
            </p>
            <div className="mt-8 space-y-4" {...revealGroup}>
              {building.map((target) => (
                <TargetCard key={target.id} target={target} />
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="text-2xl font-medium text-heading" {...reveal}>
            Not built yet
          </h2>
          <p className="mt-2 max-w-2xl text-base text-muted" {...reveal}>
            Everything below is written down so the direction is clear. None of it exists today,
            none of it can be installed or opened, there is no waiting list, and no date is being
            promised for any of it.
          </p>
          <div className="mt-8 space-y-4" {...revealGroup}>
            {notBuilt.map((target) => (
              <TargetCard key={target.id} target={target} />
            ))}
          </div>
        </section>

        <p className="max-w-2xl text-sm leading-relaxed text-muted" {...reveal}>
          Every tagged version lives on the{" "}
          <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
            releases page
          </a>{" "}
          of the{" "}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
            repository
          </a>
          , and what changed in each one is on the{" "}
          <Link href="/changelog" className={linkClass}>
            changelog
          </Link>
          .
        </p>
      </ShellSections>
    </PageShell>
  );
}
