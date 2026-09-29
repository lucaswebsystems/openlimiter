import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DownloadChoice } from "@/components/download-choice";
import { PageShell } from "@/components/page-shell";
import { JsonLd } from "@/components/json-ld";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";
import { softwareApplicationSchema } from "@/lib/jsonld";
import { downloadAssetHref, primaryDownloadHref } from "@/lib/downloads";
import { CURRENT_VERSION, REPO_URL, SITE_CONTENT_UPDATED } from "@/lib/site";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "download" });
  return pageMetadata({
    title: t("metaTitle", { version: CURRENT_VERSION }),
    description: t("metaDescription", { version: CURRENT_VERSION }),
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
    <PageShell title={t("title")} lead={t("metaDescription", { version: CURRENT_VERSION })}>
      <JsonLd data={await softwareApplicationSchema(locale)} />
      <div className="pb-6 pt-8 md:pb-10 md:pt-12">
        <p className="mb-6 text-center text-xs text-muted"><time dateTime={SITE_CONTENT_UPDATED}>{t("updated")}</time></p>
        <DownloadChoice
          windowsHref={primaryDownloadHref("windows")}
          linuxHref={primaryDownloadHref("linux")}
          macosHref={primaryDownloadHref("macos")}
          otherHref={releaseUrl}
          windowsLabel={t("choice.windows")}
          linuxLabel={t("choice.linux")}
          macosLabel={t("choice.macos")}
          otherLabel={t("choice.other")}
          windowsSummary={t("choice.windowsSummary")}
          macosSummary={t("choice.macosSummary")}
          linuxSummary={t("choice.linuxSummary")}
          versionLine={t("versionLine", { version: CURRENT_VERSION })}
          releaseNotesLabel={t("releaseNotes")}
          releaseNotesHref={releaseUrl}
          detectedLabel={t("choice.detected")}
          previewTitle={t("preview.title")}
          previewAlt={t("preview.alt")}
        />
        <section className="mx-auto mt-12 max-w-3xl text-center" aria-labelledby="package-details">
          <h2 id="package-details" className="heading-face text-xl text-heading">{t("packages.title")}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-soft">{t("packages.lead")}</p>
          <div className="mt-8 space-y-8">
            <div className="mx-auto max-w-2xl">
              <h3 className="heading-face text-lg font-semibold text-heading">{t("targets.windows.name")}</h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">{t("packages.windows")}</p>
              <a className="focus-ring mt-3 inline-flex rounded text-sm text-accent underline underline-offset-4" href={downloadAssetHref("windows", "msi")}>
                {t("targets.windows.assets.msi")}
              </a>
            </div>
            <div className="mx-auto max-w-2xl">
              <h3 className="heading-face text-lg font-semibold text-heading">{t("targets.linux.name")}</h3>
              <p className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-muted">{t("packages.linux")}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-4 text-sm">
                <a className="focus-ring text-accent underline underline-offset-4" href={downloadAssetHref("linux", "deb")}>{t("targets.linux.assets.deb")}</a>
                <a className="focus-ring text-accent underline underline-offset-4" href={downloadAssetHref("linux", "rpm")}>{t("targets.linux.assets.rpm")}</a>
              </div>
              <p className="mt-5 text-sm text-muted">{t("targets.linux.instructions.appImage")}</p>
              <code className="mt-2 inline-block max-w-full overflow-x-auto rounded-xl border border-hairline bg-frame px-4 py-3 text-left text-xs text-heading">chmod +x OpenLimiter-linux-x86_64.AppImage && ./OpenLimiter-linux-x86_64.AppImage</code>
            </div>
          </div>
        </section>

        <section className="mx-auto mt-12 max-w-4xl text-center" aria-labelledby="phone-install">
          <h2 id="phone-install" className="heading-face text-xl text-heading">{t("phone.title")}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-soft">{t("phone.lead")}</p>
          <div className="mx-auto mt-6 grid max-w-3xl grid-cols-1 items-stretch gap-4 sm:grid-cols-2">
            <article id="iphone" className="flex h-full flex-col items-center rounded-xl border border-hairline bg-surface p-6 text-center">
              <h3 className="heading-face text-lg font-semibold text-heading">{t("targets.iphone.name")}</h3>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{t("phone.iphoneGuide")}</p>
              <Link className="focus-ring mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover" href="/app">
                {t("phone.openApp")}
              </Link>
            </article>
            <article id="android" className="flex h-full flex-col items-center rounded-xl border border-hairline bg-surface p-6 text-center">
              <h3 className="heading-face text-lg font-semibold text-heading">{t("targets.android.name")}</h3>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{t("phone.androidGuide")}</p>
              <Link className="focus-ring mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent hover:bg-accent-hover" href="/app">
                {t("phone.openApp")}
              </Link>
            </article>
          </div>
        </section>

        <section id="npm" className="mx-auto mt-12 max-w-3xl space-y-4 text-center" aria-labelledby="cli-install">
          <h2 id="cli-install" className="heading-face text-xl text-heading">{t("targets.npm.name")}</h2>
          <p className="mx-auto max-w-2xl text-soft">{t("targets.npm.summary")}</p>
          <pre className="overflow-x-auto rounded-xl border border-hairline bg-frame p-5 text-center text-sm"><code>npm install -g openlimiter</code></pre>
          <p className="text-sm text-muted">{t("targets.npm.requirement")}</p>
          <a className="focus-ring inline-flex rounded text-sm text-accent underline underline-offset-4" href="https://www.npmjs.com/package/openlimiter" target="_blank" rel="noopener noreferrer">
            {t("targets.npm.hrefLabel")}
          </a>
        </section>
      </div>
    </PageShell>
  );
}
