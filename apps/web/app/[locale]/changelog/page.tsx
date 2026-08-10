import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { formatReleaseDate, readChangelog } from "@/lib/changelog";
import { pageMetadata } from "@/lib/metadata";
import { reveal, revealGroup, revealSm } from "@/lib/motion";
import { REPO_URL } from "@/lib/site";

/**
 * /changelog
 *
 * A rendering of the repository's own CHANGELOG.md, parsed by lib/changelog.ts
 * at build time. There is deliberately no second copy of this text on the site,
 * so a release note cannot say one thing in the repository and another here.
 *
 * A checkout without that file still renders, empty and honest, rather than
 * failing the build, which is why the empty branch below exists at all. Release
 * note items regularly carry full URLs, so every item is allowed to break
 * inside a word rather than push the page sideways.
 *
 * Each release anchor carries a `v` in front of the number, because an id that
 * opens with a digit is awkward to select and awkward to escape later.
 */

export const metadata: Metadata = pageMetadata({
  title: "Changelog: every release and what changed",
  description:
    "Every released version of OpenLimiter, rendered from the CHANGELOG.md at the root of the repository.",
  path: "/changelog",
});

const linkClass = "focus-ring rounded text-accent transition-colors hover:text-heading";

export default async function ChangelogPage() {
  const releases = await readChangelog();

  return (
    <PageShell
      title="Changelog"
      lead="Every released version of OpenLimiter, read straight from the file the repository itself keeps, in the order that file lists them."
    >
      {releases.length === 0 ? (
        <div className="max-w-xl rounded-xl border border-hairline bg-surface p-6" {...reveal}>
          <p className="text-sm leading-relaxed text-muted">
            No CHANGELOG.md was found in this checkout, so there is nothing to show here. The file
            this page reads sits at the root of the{" "}
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
              repository
            </a>
            , and it is the only copy of these notes there is.
          </p>
        </div>
      ) : (
        <div className="space-y-12" {...revealGroup}>
          {releases.map((release) => {
            const date = formatReleaseDate(release.date);
            return (
              <section
                key={release.version}
                id={`v${release.version}`}
                className="max-w-xl scroll-mt-8 border-t border-hairline pt-6 first:border-t-0 first:pt-0"
                {...reveal}
              >
                <h2 className="text-xl font-medium text-heading">{release.version}</h2>
                {date !== null && <p className="mt-1 text-sm text-muted">{date}</p>}

                <div className="mt-6 space-y-6">
                  {release.entries.map((entry) => (
                    <div key={`${release.version}-${entry.heading}`}>
                      <h3 className="text-sm font-medium text-heading">{entry.heading}</h3>
                      <ul className="mt-2 space-y-2">
                        {entry.items.map((item, index) => (
                          <li
                            key={index}
                            className="break-words text-sm leading-relaxed text-muted"
                          >
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <p className="mt-16 max-w-xl text-sm leading-relaxed text-muted" {...revealSm}>
        This page is rendered from the{" "}
        <a
          href={`${REPO_URL}/blob/main/CHANGELOG.md`}
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          CHANGELOG.md
        </a>{" "}
        at the root of the repository. Nothing here is written twice, so there is no second copy to
        drift out of step with the released code.
      </p>
    </PageShell>
  );
}
