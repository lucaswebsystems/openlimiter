import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, P, Steps, Table } from "@/components/docs/prose";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { docMetadata } from "@/lib/metadata";

const PROVIDERS = ["claude", "codex", "antigravity", "opencode", "openrouter"] as const;

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/zero-setup", await pageLocale(params));
}

export default async function ZeroSetupPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("docs.pages.zero-setup.sections");
  const code = (chunks: ReactNode) => <Code>{chunks}</Code>;

  return (
    <DocArticle
      id="zero-setup"
      sections={[
        {
          id: "what-it-does",
          title: t("what-it-does.title"),
          body: (
            <>
              <P>{t("what-it-does.body")}</P>
              <Callout tone="key" title={t("what-it-does.calloutTitle")}>
                {t("what-it-does.calloutBody")}
              </Callout>
            </>
          ),
        },
        {
          id: "discovery",
          title: t("discovery.title"),
          body: (
            <>
              <P>{t("discovery.intro")}</P>
              <Bullets
                items={[
                  t.rich("discovery.bullets.paths", { code }),
                  t.rich("discovery.bullets.states", { code }),
                  t("discovery.bullets.accounts"),
                  t("discovery.bullets.refresh"),
                  t("discovery.bullets.macos"),
                ]}
              />
            </>
          ),
        },
        {
          id: "providers",
          title: t("providers.title"),
          body: (
            <>
              <P>{t("providers.intro")}</P>
              <Table
                caption={t("providers.caption")}
                columns={[
                  { key: "provider", header: t("providers.columns.provider") },
                  { key: "reports", header: t("providers.columns.reports") },
                  { key: "source", header: t("providers.columns.source") },
                ]}
                rows={PROVIDERS.map((provider) => ({
                  provider: t(`providers.rows.${provider}.name`),
                  reports: t(`providers.rows.${provider}.reports`),
                  source: t(`providers.rows.${provider}.source`),
                }))}
              />
              <Callout tone="note" title={t("providers.riskTitle")}>
                {t("providers.riskBody")}
              </Callout>
            </>
          ),
        },
        {
          id: "privacy",
          title: t("privacy.title"),
          body: (
            <>
              <P>{t("privacy.intro")}</P>
              <Bullets
                items={[
                  t("privacy.bullets.local"),
                  t("privacy.bullets.endpoint"),
                  t("privacy.bullets.telemetry"),
                  t("privacy.bullets.advice"),
                  t("privacy.bullets.refresh"),
                ]}
              />
            </>
          ),
        },
        {
          id: "unknown",
          title: t("unknown.title"),
          body: (
            <>
              <P>{t("unknown.intro")}</P>
              <Steps
                items={[
                  t("unknown.steps.login"),
                  t("unknown.steps.rescan"),
                  t("unknown.steps.wait"),
                  t("unknown.steps.interface"),
                  t("unknown.steps.manual"),
                ]}
              />
              <Callout tone="key" title={t("unknown.calloutTitle")}>
                {t("unknown.calloutBody")}
              </Callout>
            </>
          ),
        },
      ]}
    />
  );
}
