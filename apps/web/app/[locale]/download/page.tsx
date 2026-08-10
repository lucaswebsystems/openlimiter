import type { Metadata } from "next";
import { PageShell, ShellSections } from "@/components/page-shell";
import { SiteLink } from "@/components/site-link";
import { ButtonLink, Chip } from "@/components/ui";
import { downloadTargets, type DownloadTarget } from "@/lib/downloads";
import { reveal, revealGroup } from "@/lib/motion";
import { RELEASES_URL, REPO_URL, SITE_URL, type ShipState } from "@/lib/site";
import { getTranslations } from "next-intl/server";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";

/**
 * /download
 *
 * One row per way of getting OpenLimiter, read straight from lib/downloads.ts,
 * so a platform cannot be advertised here and missing from the hero or the
 * footer. Each row keeps its own id, which is what the footer's deep links and
 * /download#windows land on, and which is also the key its words are under in
 * the catalog.
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

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "download" });

  return pageMetadata({
    title: t("metaTitle"),
    description: t("metaDescription"),
    route: "/download",
    locale,
  });
}

const available = downloadTargets.filter((target) => target.state === "available");
const building = downloadTargets.filter((target) => target.state === "in development");
const notBuilt = downloadTargets.filter((target) => target.state === "planned");

/**
 * The word in the chip, from the one vocabulary the whole product shares.
 *
 * The chip says the row's real ship state, so the three states are three
 * catalog entries rather than a label repeated on every row. The map exists
 * because `in development` carries a space and a catalog leaf does not.
 */
const stateKeys: Record<ShipState, string> = {
  available: "available",
  "in development": "inDevelopment",
  planned: "planned",
};

async function TargetCard({ target }: { target: DownloadTarget }) {
  const t = await getTranslations("download");

  /* The one rule this page exists to keep. Anything that is not available today
     gets no command and no download control, whatever the data happens to
     carry. */
  const shipped = target.state === "available";
  const command = shipped ? target.command : undefined;
  const href = shipped ? target.href : undefined;
  const assets = shipped ? target.assets : undefined;

  /* Every word this row shows sits under the row's own id, so no row can borrow
     another row's prose. A row with no note and no requirement has no such key,
     which is the question `t.has` asks rather than a flag in the data. */
  const words = (key: string) => `targets.${target.id}.${key}`;

  return (
    <article
      id={target.id}
      className="lift scroll-mt-8 rounded-xl border border-hairline bg-surface p-6 hover:border-hairline-strong hover:bg-raised"
      {...reveal}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xl font-medium text-heading">{t(words("name"))}</h3>
        <Chip tone={shipped ? "accent" : "neutral"}>{t(`states.${stateKeys[target.state]}`)}</Chip>
      </div>

      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{t(words("summary"))}</p>

      {assets !== undefined && assets.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-3">
          {assets.map((asset) => (
            <ButtonLink
              key={asset.href}
              href={asset.href}
              tone={asset.primary === true ? "primary" : "ghost"}
              external
            >
              {t(words(`assets.${asset.id}`))}
            </ButtonLink>
          ))}
        </div>
      )}

      {t.has(words("note")) && (
        <p className="mt-3 max-w-2xl text-xs leading-relaxed text-muted">{t(words("note"))}</p>
      )}

      {href !== undefined && (
        <div className="mt-4">
          <ButtonLink href={href} tone="primary" external={target.hrefExternal === true}>
            {t(words("hrefLabel"))}
          </ButtonLink>
        </div>
      )}

      {command !== undefined && (
        <pre className="mt-4 overflow-x-auto rounded-lg border border-hairline bg-code p-4 font-mono text-2xs leading-6 text-soft">
          <code>{command}</code>
        </pre>
      )}

      {command !== undefined && t.has(words("requirement")) && (
        <p className="mt-3 text-xs text-muted">{t(words("requirement"))}</p>
      )}
    </article>
  );
}

const linkClass = "focus-ring rounded text-accent transition-colors hover:text-accent-hover";

export default async function DownloadPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("download");

  return (
    <PageShell title={t("title")} lead={t("lead")}>
      <ShellSections>
        <section>
          <h2 className="text-2xl font-medium text-heading" {...reveal}>
            {t("available.title")}
          </h2>
          <p className="mt-2 max-w-2xl text-base text-muted" {...reveal}>
            {t("available.lead")}
          </p>
          <div className="mt-8 space-y-4" {...revealGroup}>
            {available.map((target) => (
              <TargetCard key={target.id} target={target} />
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-medium text-heading" {...reveal}>
            {t("phone.title")}
          </h2>
          <p className="mt-2 max-w-2xl text-base text-muted" {...reveal}>
            {t("phone.lead")}
          </p>
          <div
            className="mt-8 flex flex-col items-start gap-5 rounded-xl border border-hairline bg-surface p-6 sm:flex-row sm:items-center"
            {...reveal}
          >
            <span className="flex-none overflow-hidden rounded-lg border border-hairline">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/qr/openlimiter-app.svg"
                alt={t("phone.qrAlt", { url: `${SITE_URL}/app` })}
                width={180}
                height={180}
                className="block h-[180px] w-[180px]"
              />
            </span>
            <p className="text-sm leading-relaxed text-muted">{t("phone.scan")}</p>
          </div>
        </section>

        {building.length > 0 && (
          <section>
            <h2 className="text-2xl font-medium text-heading" {...reveal}>
              {t("building.title")}
            </h2>
            <p className="mt-2 max-w-2xl text-base text-muted" {...reveal}>
              {t("building.lead")}
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
            {t("notBuilt.title")}
          </h2>
          <p className="mt-2 max-w-2xl text-base text-muted" {...reveal}>
            {t("notBuilt.lead")}
          </p>
          <div className="mt-8 space-y-4" {...revealGroup}>
            {notBuilt.map((target) => (
              <TargetCard key={target.id} target={target} />
            ))}
          </div>
        </section>

        {/* One sentence with three links inside it, so it stays one message with
            three tags rather than seven fragments a translator would have to
            reassemble. The word order around the links is theirs to change. */}
        <p className="max-w-2xl text-sm leading-relaxed text-muted" {...reveal}>
          {t.rich("releasesNote", {
            releases: (chunks) => (
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                {chunks}
              </a>
            ),
            repo: (chunks) => (
              <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {chunks}
              </a>
            ),
            changelog: (chunks) => (
              <SiteLink href="/changelog" className={linkClass}>
                {chunks}
              </SiteLink>
            ),
          })}
        </p>
      </ShellSections>
    </PageShell>
  );
}
