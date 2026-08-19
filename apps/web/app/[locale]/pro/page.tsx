import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageShell } from "@/components/page-shell";
import { ProPortal } from "@/components/pro-portal";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations("proPortal");
  return {
    ...pageMetadata({ title: t("title"), description: t("lead"), route: "/pro", locale }),
    robots: {
      index: false,
      follow: false,
      noarchive: true,
      nosnippet: true,
    },
  };
}

export default async function ProPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("proPortal");
  return (
    <PageShell title={t("title")} lead={t("lead")}>
      <ProPortal />
    </PageShell>
  );
}
