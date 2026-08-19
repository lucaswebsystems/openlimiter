import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, DocLink, ExternalLink, P } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";
import { ISSUES_URL } from "@/lib/site";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/roadmap", await pageLocale(params));
}

export default async function RoadmapPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Every sentence comes from the catalog, keyed by the anchor it renders under.
     Nothing on this page is code, so nothing on it stays here. */
  const t = await getTranslations("docs.pages.roadmap.sections");

  return (
    <DocArticle
      id="roadmap"
      sections={[
        {
          id: "not-available",
          title: t("not-available.title"),
          body: (
            <Callout tone="key" title={t("not-available.calloutTitle")}>
              {t("not-available.calloutBody")}
            </Callout>
          ),
        },
        {
          id: "desktop",
          title: t("desktop.title"),
          body: (
            <>
              <P>{t("desktop.intro")}</P>
              <Bullets
                items={[
                  t("desktop.bullets.status"),
                  t("desktop.bullets.signing"),
                  t("desktop.bullets.updates"),
                ]}
              />
            </>
          ),
        },
        {
          id: "mobile",
          title: t("mobile.title"),
          body: (
            <>
              <P>{t("mobile.intro")}</P>
              <Bullets
                items={[t("mobile.bullets.status"), t("mobile.bullets.dependsOnSync")]}
              />
            </>
          ),
        },
        {
          id: "sync",
          title: t("sync.title"),
          body: (
            <>
              <P>
                {t.rich("sync.intro", {
                  pricing: (chunks) => <DocLink href="/#pricing">{chunks}</DocLink>,
                })}
              </P>
              <Bullets
                items={[
                  t("sync.bullets.status"),
                  t("sync.bullets.alerts"),
                  t("sync.bullets.history"),
                  t("sync.bullets.routing"),
                  t("sync.bullets.localFirst"),
                ]}
              />
            </>
          ),
        },
        {
          id: "following",
          title: t("following.title"),
          body: (
            <P>
              {t.rich("following.body", {
                issues: (chunks) => <ExternalLink href={ISSUES_URL}>{chunks}</ExternalLink>,
              })}
            </P>
          ),
        },
      ]}
    />
  );
}
