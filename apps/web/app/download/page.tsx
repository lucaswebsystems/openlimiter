import type { Metadata } from "next";
import Link from "next/link";
import { PageShell, ShellSections } from "@/components/page-shell";
import { Chip } from "@/components/ui";
import { DOWNLOAD_DISCLAIMER, downloadTargets, type DownloadTarget } from "@/lib/downloads";
import { RELEASES_URL, REPO_URL } from "@/lib/site";

/**
 * /download
 *
 * One row per way of getting OpenLimiter, read straight from lib/downloads.ts,
 * so a platform cannot be advertised here and missing from the hero or the
 * footer. Each row keeps its own id, which is what the footer's deep links and
 * /download#windows land on.
 *
 * The page is split in two on purpose: what a reader can run today, and what is
 * not built. A command renders only for a row that is already available, and
 * that is checked here rather than trusted from the data, so a row that gains a
 * command before it ships still cannot be made to look installable.
 */

export const metadata: Metadata = {
  title: "Download",
  description:
    "Install the OpenLimiter command line tool on Windows, macOS or Linux, or build it from a clone. Desktop, web and mobile are not built yet.",
  alternates: { canonical: "/download" },
};

const available = downloadTargets.filter((target) => target.state === "available");
const notBuilt = downloadTargets.filter((target) => target.state !== "available");

function TargetCard({ target }: { target: DownloadTarget }) {
  /* The one rule this page exists to keep. Anything that is not available today
     gets no command, whatever the data happens to carry. */
  const command = target.state === "available" ? target.command : undefined;

  return (
    <article
      id={target.id}
      className="scroll-mt-8 rounded-xl border border-hairline bg-surface p-6"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xl font-medium text-heading">{target.name}</h3>
        <Chip tone={target.state === "available" ? "accent" : "neutral"}>{target.state}</Chip>
      </div>

      <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{target.summary}</p>

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

const linkClass = "focus-ring rounded text-accent transition-colors hover:text-heading";

export default function DownloadPage() {
  return (
    <PageShell title="Download" lead={DOWNLOAD_DISCLAIMER}>
      <ShellSections>
        <section>
          <h2 className="text-2xl font-medium text-heading">Available now</h2>
          <p className="mt-2 max-w-lg text-base text-muted">
            One clone, one build, the same five lines on every platform, because the tool is plain
            Node.js with no third party runtime dependencies. This is the path every capture on
            this site was taken from.
          </p>
          <div className="mt-8 space-y-4">
            {available.map((target) => (
              <TargetCard key={target.id} target={target} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-medium text-heading">Not built yet</h2>
          <p className="mt-2 max-w-lg text-base text-muted">
            Everything below is written down so the direction is clear. None of it exists today,
            none of it can be installed or opened, there is no waiting list, and no date is being
            promised for any of it.
          </p>
          <div className="mt-8 space-y-4">
            {notBuilt.map((target) => (
              <TargetCard key={target.id} target={target} />
            ))}
          </div>
        </section>

        <p className="max-w-xl text-sm leading-relaxed text-muted">
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
