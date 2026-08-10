import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, DocLink, P, Sub } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/why-openlimiter", await pageLocale(params));
}

export default async function WhyPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Every sentence comes from the catalog, keyed by the anchor it renders under.
     The lead in words of the three bullets below are emphasis inside a sentence,
     so each bullet stays one message with a tag rather than a bold word glued to
     a paragraph. */
  const t = await getTranslations("docs.pages.why-openlimiter.sections");
  const strong = (chunks: ReactNode) => (
    <strong className="font-medium text-heading">{chunks}</strong>
  );

  return (
    <DocArticle
      id="why-openlimiter"
      sections={[
        {
          id: "the-problem",
          title: t("the-problem.title"),
          body: (
            <>
              <P>{t("the-problem.interruption")}</P>
              <P>{t("the-problem.scattered")}</P>
            </>
          ),
        },
        {
          id: "what-it-does",
          title: t("what-it-does.title"),
          body: (
            <>
              <P>{t("what-it-does.intro")}</P>
              <Bullets
                items={[
                  t.rich("what-it-does.bullets.read", { strong }),
                  t.rich("what-it-does.bullets.normalise", { strong }),
                  t.rich("what-it-does.bullets.advise", { strong }),
                ]}
              />
            </>
          ),
        },
        {
          id: "what-it-is-not",
          title: t("what-it-is-not.title"),
          body: (
            <>
              <Callout tone="key" title={t("what-it-is-not.calloutTitle")}>
                {t("what-it-is-not.calloutBody")}
              </Callout>
              <Bullets
                items={[
                  t("what-it-is-not.bullets.proxy"),
                  t("what-it-is-not.bullets.dashboard"),
                  t("what-it-is-not.bullets.billing"),
                ]}
              />
            </>
          ),
        },
        {
          id: "design-rules",
          title: t("design-rules.title"),
          body: (
            <>
              <Sub id="unknown-stays-unknown">
                {t("design-rules.unknown-stays-unknown.title")}
              </Sub>
              <P>{t("design-rules.unknown-stays-unknown.body")}</P>
              <Sub id="truncated-not-rounded">
                {t("design-rules.truncated-not-rounded.title")}
              </Sub>
              <P>{t("design-rules.truncated-not-rounded.body")}</P>
              <Sub id="one-bad-row">{t("design-rules.one-bad-row.title")}</Sub>
              <P>{t("design-rules.one-bad-row.body")}</P>
              <Sub id="local-first">{t("design-rules.local-first.title")}</Sub>
              <P>
                {t.rich("design-rules.local-first.body", {
                  config: (chunks) => <DocLink href="/docs/configuration">{chunks}</DocLink>,
                  security: (chunks) => <DocLink href="/docs/security">{chunks}</DocLink>,
                  code: (chunks) => <Code>{chunks}</Code>,
                })}
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
