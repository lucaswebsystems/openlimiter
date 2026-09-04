import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DownloadChoice } from "@/components/download-choice";
import { PageShell } from "@/components/page-shell";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { downloadTargets } from "@/lib/downloads";
import { pageMetadata } from "@/lib/metadata";
import { CURRENT_VERSION, REPO_URL } from "@/lib/site";

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

function primaryAsset(platform: "windows" | "linux" | "macos"): string {
  const target = downloadTargets.find((entry) => entry.id === platform);
  const asset = target?.assets?.find((entry) => entry.primary === true);
  if (asset === undefined) throw new Error(`Missing ${platform} download asset.`);
  return asset.href;
}

export default async function DownloadPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("download");

  return (
    <PageShell title={t("title")} lead={t("metaDescription")}>
      <div className="py-10 md:py-16">
        <DownloadChoice
          windowsHref={primaryAsset("windows")}
          linuxHref={primaryAsset("linux")}
          macosHref={primaryAsset("macos")}
          otherHref={`${REPO_URL}/releases/tag/v${CURRENT_VERSION}`}
          windowsLabel={t("choice.windows")}
          linuxLabel={t("choice.linux")}
          macosLabel={t("choice.macos")}
          otherLabel={t("choice.other")}
          smartScreen={t("choice.smartScreen")}
          openAnyway={t("choice.openAnyway")}
          linuxNote={t("choice.linuxNote")}
        />
      </div>
    </PageShell>
  );
}
