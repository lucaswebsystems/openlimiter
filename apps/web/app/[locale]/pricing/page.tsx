import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Pricing } from "@/components/pricing";
import { SHELL } from "@/components/ui";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "pricing" });

  return pageMetadata({
    title: t("title"),
    description: t("lead"),
    route: "/pricing",
    locale,
  });
}

export default async function PricingPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("pricing");

  return (
    <main id="main" className={`${SHELL} pb-20 pt-4 md:pt-10`}>
      <h1 className="sr-only">{t("title")}</h1>
      <Pricing />
    </main>
  );
}
