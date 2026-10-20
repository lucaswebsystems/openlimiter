import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { formatReleaseDate, readChangelog, type ChangelogRelease } from "@/lib/changelog";
import { pageMetadata } from "@/lib/metadata";
import { reveal, revealGroup, revealSm } from "@/lib/motion";
import { REPO_URL } from "@/lib/site";
import { getTranslations } from "next-intl/server";
import { type LocaleParams, pageLocale } from "@/i18n/params";

/**
 * /changelog
 *
 * A rendering of the repository's own CHANGELOG.md, parsed by lib/changelog.ts
 * at build time. There is deliberately no second copy of this text on the site,
 * so a release note cannot say one thing in the repository and another here.
 *
 * Which is also why only the page's own chrome is translated. The heading, the
 * lead, the empty state and the closing note come from the catalog; every
 * version number, group heading and release note below comes from that one file
 * and stays in the language it was written in. Translating it here would create
 * exactly the second copy this page exists to avoid.
 *
 * A checkout without that file still renders, empty and honest, rather than
 * failing the build, which is why the empty branch below exists at all. Release
 * note items regularly carry full URLs, so every item is allowed to break
 * inside a word rather than push the page sideways.
 *
 * Each release anchor carries a `v` in front of the number, because an id that
 * opens with a digit is awkward to select and awkward to escape later.
 *
 * The latest three releases are open, and every older one is a single dated
 * line in the index under them that opens in place, so the page is a few
 * screens rather than twenty three thousand pixels. The column is centred under
 * the centred heading, and lines a release carries before any group heading
 * are drawn with no heading of the page's own.
 */

/** How many releases are drawn open. Every older one is a line in the index. */
const OPEN_RELEASES = 3;

function ReleaseNotes({ release }: { release: ChangelogRelease }) {
  return (
    <div className="mt-6 space-y-6">
      {release.entries.map((entry, index) => (
        <div key={`${release.version}-${index}`}>
          {entry.heading !== null && <h3 className="text-sm font-medium text-heading">{entry.heading}</h3>}
          <ul className={entry.heading === null ? "space-y-2" : "mt-2 space-y-2"}>
            {entry.items.map((item, line) => (
              <li key={line} className="break-words text-sm leading-relaxed text-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "changelog" });

  return pageMetadata({
    title: t("metaTitle"),
    description: t("metaDescription"),
    route: "/changelog",
    locale,
  });
}

const linkClass = "focus-ring rounded text-accent transition-colors hover:text-heading";

export default async function ChangelogPage({ params }: LocaleParams) {
  const locale = await pageLocale(params);
  const t = await getTranslations("changelog");

  const releases = await readChangelog();

  return (
    <PageShell title={t("title")} lead={t("lead")}>
      {releases.length === 0 ? (
        <div className="mx-auto max-w-xl rounded-xl border border-hairline bg-surface p-6" {...reveal}>
          <p className="text-sm leading-relaxed text-muted">
            {t.rich("empty", {
              repo: (chunks) => (
                <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
                  {chunks}
                </a>
              ),
            })}
          </p>
        </div>
      ) : (
        <div className="mx-auto max-w-xl">
          <div className="space-y-12" {...revealGroup}>
            {releases.slice(0, OPEN_RELEASES).map((release) => {
              const date = formatReleaseDate(release.date, locale);
              return (
                <section
                  key={release.version}
                  id={`v${release.version}`}
                  className="mx-auto max-w-xl scroll-mt-8 border-t border-hairline pt-6 first:border-t-0 first:pt-0"
                  {...reveal}
                >
                  <h2 className="text-xl font-medium text-heading">{release.version}</h2>
                  {date !== null && <p className="mt-1 text-sm text-muted">{date}</p>}
                  <ReleaseNotes release={release} />
                </section>
              );
            })}
          </div>

          {releases.length > OPEN_RELEASES && (
            <div className="mt-12 divide-y divide-hairline border-y border-hairline" {...revealSm}>
              {releases.slice(OPEN_RELEASES).map((release) => {
                const date = formatReleaseDate(release.date, locale);
                return (
                  <details key={release.version} id={`v${release.version}`} className="scroll-mt-8 py-3">
                    <summary className="focus-ring flex cursor-pointer items-baseline justify-between gap-4 rounded text-sm">
                      <span className="font-medium text-heading">{release.version}</span>
                      {date !== null && <span className="text-muted">{date}</span>}
                    </summary>
                    <ReleaseNotes release={release} />
                  </details>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* One sentence with the file's own name linked inside it, so it stays one
          message with one tag rather than three fragments. */}
      <p className="mx-auto mt-16 max-w-[70ch] text-center text-sm leading-relaxed text-muted" {...revealSm}>
        {t.rich("sourceNote", {
          file: (chunks) => (
            <a
              href={`${REPO_URL}/blob/main/CHANGELOG.md`}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              {chunks}
            </a>
          ),
        })}
      </p>
    </PageShell>
  );
}
