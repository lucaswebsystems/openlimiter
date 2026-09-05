import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageShell } from "@/components/page-shell";
import { ProPortal } from "@/components/pro-portal";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";

/**
 * The Pro account page.
 *
 * It carries a session, a billing state and a device list, so it is kept out of
 * every index deliberately: nothing here is a page a search engine should ever
 * serve, and the marketing case for Pro is made on /pricing, which is indexed.
 */

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "proPortal" });
  return {
    ...pageMetadata({
      title: t("title"),
      description: t("metaDescription"),
      route: "/pro",
      locale,
    }),
    robots: {
      index: false,
      follow: false,
      noarchive: true,
      nosnippet: true,
    },
  };
}

export default async function ProPage({ params }: LocaleParams) {
  const locale = await pageLocale(params);
  const t = await getTranslations("proPortal");
  return (
    <PageShell title={t("title")} lead={t("lead")} quietChrome>
      <ProPortal locale={locale} />
    </PageShell>
  );
}
