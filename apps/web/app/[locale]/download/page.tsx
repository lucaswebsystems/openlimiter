import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DownloadChoice } from "@/components/download-choice";
import { DocLink } from "@/components/docs/prose";
import { PageShell } from "@/components/page-shell";
import { JsonLd } from "@/components/json-ld";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { localePath } from "@/i18n/routing";
import { formatReleaseDate } from "@/lib/changelog";
import { PANEL_IMAGE, pageMetadata } from "@/lib/metadata";
import { softwareApplicationSchema } from "@/lib/jsonld";
import { downloadAssetHref } from "@/lib/downloads";
import { CURRENT_VERSION, REPO_URL, SITE_CONTENT_UPDATED } from "@/lib/site";

/** A multi line command block, left aligned inside the centred column. */
const COMMANDS =
  "mx-auto mt-3 block w-fit max-w-full overflow-x-auto rounded-xl border border-hairline bg-frame px-5 py-4 text-left text-sm text-heading";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "download" });
  return pageMetadata({
    title: t("metaTitle", { version: CURRENT_VERSION }),
    description: t("metaDescription", { version: CURRENT_VERSION }),
    route: "/download",
    locale,
    image: PANEL_IMAGE,
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
  const updated = formatReleaseDate(SITE_CONTENT_UPDATED, locale) ?? SITE_CONTENT_UPDATED;
  const linkClass = "focus-ring rounded text-accent underline underline-offset-4";

  return (
    <PageShell title={t("title")} lead={t("metaDescription", { version: CURRENT_VERSION })}>
      <JsonLd data={await softwareApplicationSchema(locale)} />
      <div className="pb-6 pt-8 md:pb-10 md:pt-12">
        <p className="mb-6 text-center text-xs text-muted">
          <time dateTime={SITE_CONTENT_UPDATED}>{t("updated", { date: updated })}</time>
        </p>
        {/* Each desktop button goes through /download/started, which starts
            the file and is what counts the click. */}
        <DownloadChoice
          windowsHref={localePath(locale, "/download/started/windows")}
          linuxHref={localePath(locale, "/download/started/linux")}
          macosHref={localePath(locale, "/download/started/macos")}
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
          mobile={{
            title: t("mobile.title"),
            body: t("mobile.body"),
            share: t("mobile.share"),
            copy: t("mobile.copy"),
            copied: t("mobile.copied"),
            source: t("mobile.source"),
            sourceHref: REPO_URL,
          }}
        >
          {/* The browser warning, the two system prompts by name, and where
              GitHub shows each file's SHA256 digest. Open Anyway is the
              documented macOS path; no quarantine command is ever given. */}
          {t.rich("safety", {
            release: (chunks) => (
              <a href={releaseUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
                {chunks}
              </a>
            ),
          })}
        </DownloadChoice>
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
                {/* The button above is the deb now, so the AppImage is offered here. */}
                <a className="focus-ring text-accent underline underline-offset-4" href={downloadAssetHref("linux", "appImage")}>{t("targets.linux.assets.appImage")}</a>
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

        <section id="disclosure" className="mx-auto mt-12 max-w-3xl text-center" aria-labelledby="disclosure-title">
          <h2 id="disclosure-title" className="heading-face text-xl text-heading">{t("disclosure.title")}</h2>
          <ul className="mx-auto mt-4 max-w-2xl space-y-3 text-sm leading-relaxed text-soft">
            <li>{t("disclosure.webview")}</li>
            <li>{t("disclosure.updates")}</li>
            <li>{t("disclosure.logins")}</li>
            <li>{t("disclosure.claude")}</li>
          </ul>
        </section>

        <section id="uninstall" className="mx-auto mt-12 max-w-3xl text-center" aria-labelledby="uninstall-title">
          <h2 id="uninstall-title" className="heading-face text-xl text-heading">{t("uninstall.title")}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-soft">{t("uninstall.lead")}</p>
          <pre className={COMMANDS}><code>{"openlimiter terminal uninstall <host>\nopenlimiter hooks uninstall <agent>\nnpm uninstall -g openlimiter"}</code></pre>
          <div className="mx-auto mt-6 max-w-2xl space-y-3 text-sm leading-relaxed text-muted">
            <p>{t("uninstall.first")}</p>
            <p>{t("uninstall.windows")}</p>
            <p>{t("uninstall.macos")}</p>
            <p>{t("uninstall.linux")}</p>
          </div>
          <pre className={COMMANDS}><code>{"sudo apt remove open-limiter\nsudo dnf remove open-limiter"}</code></pre>
          <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-muted">
            {t.rich("uninstall.data", {
              docs: (chunks) => <DocLink href="/docs/configuration">{chunks}</DocLink>,
            })}
          </p>
        </section>
      </div>
    </PageShell>
  );
}
