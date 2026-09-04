import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub, Table } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/providers", await pageLocale(params));
}

/**
 * The connector ids, in the order the first table lists them.
 *
 * These are the parser ids, spelled exactly as `openlimiter ingest --provider`
 * wants them, which is why Gemini appears as `gemini_cli`. Nine ship: the six
 * this page has always listed, plus the three that arrived with the Gemini CLI,
 * Grok and Kimi readers.
 */
const CONNECTOR_IDS = [
  "claude",
  "openrouter",
  "codex",
  "antigravity",
  "gemini_cli",
  "grok",
  "kimi",
  "opencode",
  "manual",
] as const;

export default async function ProvidersPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Sentences come from the catalog, keyed by the anchor they render under, and
     a table row's prose is keyed by the connector id in its own first column.
     The ids themselves, and the label values in the second table, are the
     product's own vocabulary and stay here. */
  const t = await getTranslations("docs.pages.providers.sections");

  return (
    <DocArticle
      id="providers"
      sections={[
        {
          id: "the-nine",
          title: t("the-nine.title"),
          body: (
            <>
              <Table
                caption={t("the-nine.caption")}
                columns={[
                  { key: "id", header: t("the-nine.columns.id") },
                  { key: "reads", header: t("the-nine.columns.reads") },
                  { key: "status", header: t("the-nine.columns.status") },
                ]}
                rows={CONNECTOR_IDS.map((id) => ({
                  id: <Code>{id}</Code>,
                  reads: t(`the-nine.rows.${id}.reads`),
                  status: t(`the-nine.rows.${id}.status`),
                }))}
              />
              <Callout tone="key" title={t("the-nine.calloutTitle")}>
                {t.rich("the-nine.calloutBody", {
                  code: (chunks) => <Code>{chunks}</Code>,
                })}
              </Callout>
            </>
          ),
        },
        {
          id: "how-data-arrives",
          title: t("how-data-arrives.title"),
          body: (
            <>
              <P>{t("how-data-arrives.intro")}</P>
              <Bullets
                items={[
                  t.rich("how-data-arrives.bullets.claude", {
                    code: (chunks) => <Code>{chunks}</Code>,
                  }),
                  t.rich("how-data-arrives.bullets.manual", {
                    code: (chunks) => <Code>{chunks}</Code>,
                  }),
                  t.rich("how-data-arrives.bullets.ingestOnly", {
                    code: (chunks) => <Code>{chunks}</Code>,
                  }),
                ]}
              />
              <P>
                {t.rich("how-data-arrives.exactShapes", {
                  docs: (chunks) => <DocLink href="/docs/ingestion">{chunks}</DocLink>,
                })}
              </P>
            </>
          ),
        },
        {
          id: "labels",
          title: t("labels.title"),
          body: (
            <>
              <P>{t("labels.intro")}</P>
              <Table
                caption={t("labels.caption")}
                columns={[
                  { key: "label", header: t("labels.columns.label") },
                  { key: "values", header: t("labels.columns.values") },
                ]}
                /* Three of these four cells are nothing but the enum values
                   themselves, separated by commas, so they stay here. The
                   automation risk row is the one that spends a word, and one
                   English word in a table is still a sentence to translate. */
                rows={[
                  {
                    label: <Code>credentialOrigin</Code>,
                    values: (
                      <>
                        <Code>official-local-tool</Code>, <Code>user-key</Code>,{" "}
                        <Code>browser-session</Code>, <Code>user-entered</Code>
                      </>
                    ),
                  },
                  {
                    label: <Code>dataInterfaceStatus</Code>,
                    values: (
                      <>
                        <Code>native-statusline-payload</Code>, <Code>documented-api</Code>,{" "}
                        <Code>internal-endpoint</Code>, <Code>authenticated-scrape</Code>,{" "}
                        <Code>manual</Code>
                      </>
                    ),
                  },
                  {
                    label: <Code>automationRisk</Code>,
                    values: t.rich("labels.rows.automationRisk.values", {
                      code: (chunks) => <Code>{chunks}</Code>,
                    }),
                  },
                  {
                    label: <Code>verification</Code>,
                    values: <Code>UNVERIFIED</Code>,
                  },
                ]}
              />
              <Sub id="drift">{t("labels.drift.title")}</Sub>
              <P>{t("labels.drift.body")}</P>
            </>
          ),
        },
        {
          id: "openrouter-key",
          title: t("openrouter-key.title"),
          body: (
            <>
              <P>{t("openrouter-key.intro")}</P>
              <Callout tone="note" title={t("openrouter-key.calloutTitle")}>
                {t.rich("openrouter-key.calloutBody", {
                  code: (chunks) => <Code>{chunks}</Code>,
                })}
              </Callout>
              <CodeBlock
                label={t("openrouter-key.terminalLabel")}
                code={`openlimiter ingest --provider openrouter --payload '{"data":{"total_credits":15,"total_usage":14.2}}'`}
              />
            </>
          ),
        },
        {
          id: "not-yet",
          title: t("not-yet.title"),
          body: (
            <>
              <P>{t("not-yet.body")}</P>
            </>
          ),
        },
      ]}
    />
  );
}
