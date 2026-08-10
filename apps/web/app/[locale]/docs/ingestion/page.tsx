import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/ingestion", await pageLocale(params));
}

export default async function IngestionPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Sentences come from the catalog, keyed by the anchor they render under. The
     payload bodies, the field names inside them, and the commands stay here:
     they are the shapes this page documents, not words about them. */
  const t = await getTranslations("docs.pages.ingestion.sections");
  const code = (chunks: ReactNode) => <Code>{chunks}</Code>;

  return (
    <DocArticle
      id="ingestion"
      sections={[
        {
          id: "statusline",
          title: t("statusline.title"),
          body: (
            <>
              <P>{t.rich("statusline.intro", { code })}</P>
              <CodeBlock
                label={t("statusline.blockLabel")}
                code={`{
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  }
}`}
              />
              <P>{t.rich("statusline.fields", { code })}</P>
              <Bullets
                items={[
                  t.rich("statusline.bullets.rateLimits", { code }),
                  t("statusline.bullets.implausibleReset"),
                ]}
              />
              <P>{t("statusline.ignored")}</P>
              <Callout tone="key" title={t("statusline.calloutTitle")}>
                {t("statusline.calloutBody")}
              </Callout>
            </>
          ),
        },
        {
          id: "manual-document",
          title: t("manual-document.title"),
          body: (
            <>
              <P>
                {t.rich("manual-document.intro", {
                  code,
                  docs: (chunks) => <DocLink href="/docs/configuration">{chunks}</DocLink>,
                })}
              </P>
              <CodeBlock
                label="manual.json"
                code={`{
  "version": 1,
  "meters": [
    { "name": "MONTHLY", "used_percent": 61.5, "reset_at": "2026-08-29T12:11:29.714Z" }
  ]
}`}
              />
              <Sub id="manual-rules">{t("manual-document.manual-rules.title")}</Sub>
              <Bullets
                items={[
                  t.rich("manual-document.manual-rules.bullets.name", { code }),
                  t.rich("manual-document.manual-rules.bullets.usedPercent", { code }),
                  t.rich("manual-document.manual-rules.bullets.resetAt", { code }),
                  t("manual-document.manual-rules.bullets.ten"),
                  t("manual-document.manual-rules.bullets.dropped"),
                ]}
              />
              <P>{t.rich("manual-document.refresh", { code })}</P>
            </>
          ),
        },
        {
          id: "ingest-command",
          title: t("ingest-command.title"),
          body: (
            <>
              <P>{t.rich("ingest-command.intro", { code })}</P>
              <CodeBlock
                label={t("ingest-command.terminalLabel")}
                code={`echo '{"meters":[{"name":"AGENT_BUDGET","used_percent":12.5,"reset_at":"2026-08-09T13:11:30.141Z"}]}' | openlimiter ingest

openlimiter ingest --payload '{"meters":[{"name":"AGENT_BUDGET","used_percent":12.5,"reset_at":"2026-08-09T13:11:30.141Z"}]}'`}
              />
              <P>{t.rich("ingest-command.provider", { code })}</P>
              <CodeBlock
                label={t("ingest-command.terminalLabel")}
                code={`openlimiter ingest --provider codex --payload '{"rate_limits":{"primary_window":{"used_percent":33,"reset_at":"2026-08-09T14:11:30.264Z"}}}'`}
              />
              <P>{t.rich("ingest-command.validIds", { code })}</P>
            </>
          ),
        },
        {
          id: "merging",
          title: t("merging.title"),
          body: (
            <>
              <P>{t("merging.intro")}</P>
              <Bullets
                items={[
                  t("merging.bullets.validated"),
                  t("merging.bullets.bounds"),
                  t("merging.bullets.atomic"),
                  t("merging.bullets.freshness"),
                ]}
              />
              <P>{t("merging.nothingSurvives")}</P>
            </>
          ),
        },
      ]}
    />
  );
}
