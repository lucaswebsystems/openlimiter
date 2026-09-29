import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DownloadChoice } from "@/components/download-choice";
import { PageShell } from "@/components/page-shell";
import { JsonLd } from "@/components/json-ld";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";
import { softwareApplicationSchema } from "@/lib/jsonld";
import { CURRENT_VERSION, REPO_URL, SITE_CONTENT_UPDATED, STABLE_DOWNLOADS } from "@/lib/site";

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

export default async function DownloadPage({ params }: LocaleParams) {
  const locale = await pageLocale(params);
  const t = await getTranslations("download");

  /* The other platforms link and the release notes link point at the same
     tagged release page: one reason to visit is grabbing an asset this page
     has no button for, the other is reading what changed, and GitHub answers
     both from one URL. Computed once so the two props never drift apart. */
  const releaseUrl = `${REPO_URL}/releases/tag/v${CURRENT_VERSION}`;

  return (
    <PageShell title={t("title")} lead={t("metaDescription")}>
      <JsonLd data={await softwareApplicationSchema(locale)} />
      <div className="py-10 md:py-16">
        <p className="mb-8 max-w-3xl text-base leading-relaxed text-soft">{t("releaseLead")}</p>
        <p className="mb-6 text-xs text-muted"><time dateTime={SITE_CONTENT_UPDATED}>{t("updated")}</time></p>
        <DownloadChoice
          windowsHref={STABLE_DOWNLOADS.windows}
          linuxHref={STABLE_DOWNLOADS.linux}
          macosHref={STABLE_DOWNLOADS.macos}
          otherHref={releaseUrl}
          windowsLabel={t("choice.windows")}
          linuxLabel={t("choice.linux")}
          macosLabel={t("choice.macos")}
          otherLabel={t("choice.other")}
          smartScreen={t("choice.smartScreen")}
          openAnyway={t("choice.openAnyway")}
          linuxNote={t("choice.linuxNote")}
          versionLine={t("versionLine", { version: CURRENT_VERSION })}
          releaseNotesLabel={t("releaseNotes")}
          releaseNotesHref={releaseUrl}
        />
        <section className="mt-12 space-y-4" aria-labelledby="cli-install">
          <h2 id="cli-install" className="heading-face text-xl text-heading">{t("targets.npm.name")}</h2>
          <p className="text-soft">{t("targets.npm.summary")}</p>
          <pre className="overflow-x-auto rounded-xl border border-hairline bg-frame p-5 text-sm"><code>npm install -g openlimiter</code></pre>
          <p className="text-sm text-muted">{t("targets.npm.requirement")}</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <a className="focus-ring text-accent" href={STABLE_DOWNLOADS.msi}>{t("targets.windows.assets.msi")}</a>
            <a className="focus-ring text-accent" href={STABLE_DOWNLOADS.deb}>{t("targets.linux.assets.deb")}</a>
            <a className="focus-ring text-accent" href={STABLE_DOWNLOADS.rpm}>{t("targets.linux.assets.rpm")}</a>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
