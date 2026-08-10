import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Steps, Sub } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs", await pageLocale(params));
}

export default async function GettingStartedPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Every sentence on this page comes from the catalog, keyed by the section
     anchor it renders under. What stays in this file is what a translator must
     never touch: the shell commands, the settings.json body, and the command
     names inside them. */
  const t = await getTranslations("docs.pages.index.sections");

  return (
    <DocArticle
      id="index"
      sections={[
        {
          id: "what-you-need",
          title: t("what-you-need.title"),
          body: (
            <>
              <Bullets
                items={[
                  t("what-you-need.bullets.node"),
                  t("what-you-need.bullets.npm"),
                ]}
              />
              <P>{t("what-you-need.local")}</P>
            </>
          ),
        },
        {
          id: "install",
          title: t("install.title"),
          body: (
            <>
              <P>{t("install.intro")}</P>
              <CodeBlock
                label={t("install.terminalLabel")}
                code={`npm install -g openlimiter
openlimiter demo`}
              />
              <P>
                {t.rich("install.demo", {
                  code: (chunks) => <Code>{chunks}</Code>,
                })}
              </P>
            </>
          ),
        },
        {
          id: "first-data",
          title: t("first-data.title"),
          body: (
            <>
              <P>{t("first-data.parser")}</P>
              <P>{t("first-data.statusline")}</P>
              <CodeBlock
                label={t("first-data.terminalLabel")}
                code={`openlimiter statusline < session.json
OpenLimiter NEAR_CAP NONE UNKNOWN OPENROUTER,CODEX,ANTIGRAVITY,OPENCODE,MANUAL  CLAUDE ####. 87.5%`}
              />
              <P>
                {t.rich("first-data.fallback", {
                  docs: (chunks) => <DocLink href="/docs/ingestion">{chunks}</DocLink>,
                })}
              </P>
            </>
          ),
        },
        {
          id: "claude-code",
          title: t("claude-code.title"),
          body: (
            <>
              <P>
                {t.rich("claude-code.intro", {
                  code: (chunks) => <Code>{chunks}</Code>,
                })}
              </P>
              <CodeBlock
                label="settings.json"
                code={`{
  "statusLine": {
    "type": "command",
    "command": "openlimiter statusline"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "openlimiter hook"
          }
        ]
      }
    ]
  }
}`}
              />
              <Callout tone="key" title={t("claude-code.calloutTitle")}>
                {t("claude-code.calloutBody")}
              </Callout>
            </>
          ),
        },
        {
          id: "from-source",
          title: t("from-source.title"),
          body: (
            <>
              <P>{t("from-source.intro")}</P>
              <CodeBlock
                label={t("from-source.terminalLabel")}
                code={`git clone https://github.com/lucaswebsystems/openlimiter
cd openlimiter
pnpm install
pnpm build
pnpm typecheck
pnpm test
node packages/cli/dist/bin.js demo`}
              />
              <P>{t("from-source.buildOrder")}</P>
            </>
          ),
        },
        {
          id: "where-next",
          title: t("where-next.title"),
          body: (
            <>
              <Sub id="reading-order">{t("where-next.reading-order.title")}</Sub>
              {/* Each step is one sentence that happens to open with a link, so the
                  link text travels with the sentence rather than being pasted in
                  front of it. */}
              <Steps
                items={[
                  t.rich("where-next.reading-order.steps.why", {
                    docs: (chunks) => (
                      <DocLink href="/docs/why-openlimiter">{chunks}</DocLink>
                    ),
                  }),
                  t.rich("where-next.reading-order.steps.providers", {
                    docs: (chunks) => <DocLink href="/docs/providers">{chunks}</DocLink>,
                  }),
                  t.rich("where-next.reading-order.steps.agentContext", {
                    docs: (chunks) => <DocLink href="/docs/agent-context">{chunks}</DocLink>,
                  }),
                  t.rich("where-next.reading-order.steps.cli", {
                    docs: (chunks) => <DocLink href="/docs/cli">{chunks}</DocLink>,
                  }),
                ]}
              />
            </>
          ),
        },
      ]}
    />
  );
}
