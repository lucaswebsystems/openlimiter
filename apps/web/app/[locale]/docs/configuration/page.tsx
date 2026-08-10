import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub, Table } from "@/components/docs/prose";
import {
  CAPTURED_ON,
  configCapture,
  statuslineCapture,
  statuslineNarrowCapture,
  statuslinePlainCapture,
} from "@/lib/cli-capture";
import { docMetadata } from "@/lib/metadata";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/configuration", await pageLocale(params));
}

/** The six statusline keys, in the order the table lists them. */
const STATUSLINE_KEYS = ["order", "meters", "width", "rows", "bars", "color"] as const;

export default async function ConfigurationPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Sentences come from the catalog, keyed by the anchor they render under, and
     each table row's prose by the identifier in its own first column. Paths,
     file names, configuration keys and the captured transcripts stay here. */
  const t = await getTranslations("docs.pages.configuration.sections");
  const code = (chunks: ReactNode) => <Code>{chunks}</Code>;

  return (
    <DocArticle
      id="configuration"
      sections={[
        {
          id: "state-directory",
          title: t("state-directory.title"),
          body: (
            <>
              <Table
                caption={t("state-directory.caption")}
                columns={[
                  { key: "platform", header: t("state-directory.columns.platform") },
                  { key: "path", header: t("state-directory.columns.path") },
                ]}
                /* Three operating system names and three paths. Nothing in this
                   table is a sentence, so nothing in it is translated. */
                rows={[
                  {
                    platform: "Windows",
                    path: <Code>%LOCALAPPDATA%\openlimiter</Code>,
                  },
                  {
                    platform: "macOS",
                    path: <Code>~/Library/Application Support/openlimiter</Code>,
                  },
                  {
                    platform: "Linux",
                    path: <Code>${"{XDG_STATE_HOME:-~/.local/state}"}/openlimiter</Code>,
                  },
                ]}
              />
              <P>{t("state-directory.permissions")}</P>
            </>
          ),
        },
        {
          id: "files",
          title: t("files.title"),
          body: (
            <Table
              caption={t("files.caption")}
              columns={[
                { key: "file", header: t("files.columns.file") },
                { key: "role", header: t("files.columns.role") },
              ]}
              rows={[
                {
                  file: <Code>openlimiter-config.json</Code>,
                  role: t.rich("files.rows.config.role", { code }),
                },
                {
                  file: <Code>openlimiter-cache.json</Code>,
                  role: t("files.rows.cache.role"),
                },
                {
                  file: <Code>openlimiter.lock</Code>,
                  role: t("files.rows.lock.role"),
                },
                {
                  file: <Code>manual.json</Code>,
                  role: t.rich("files.rows.manual.role", {
                    docs: (chunks) => <DocLink href="/docs/ingestion">{chunks}</DocLink>,
                  }),
                },
              ]}
            />
          ),
        },
        {
          id: "cache-behaviour",
          title: t("cache-behaviour.title"),
          body: (
            <>
              <Bullets
                items={[
                  t("cache-behaviour.bullets.oneFile"),
                  t("cache-behaviour.bullets.readers"),
                  t("cache-behaviour.bullets.writers"),
                  t("cache-behaviour.bullets.atomic"),
                ]}
              />
              <P>{t.rich("cache-behaviour.doctor", { code })}</P>
            </>
          ),
        },
        {
          id: "statusline",
          title: t("statusline.title"),
          body: (
            <>
              <P>{t.rich("statusline.intro", { code })}</P>
              {/* The capture date is a real value from lib/cli-capture.ts, so the
                  caption takes it as an argument rather than spelling it out. */}
              <CodeBlock
                label={t("statusline.capturedFixturesLabel", { date: CAPTURED_ON })}
                code={`${statuslineCapture.command}\n${statuslineCapture.output}`}
              />
              <Sub id="statusline-keys">{t("statusline.statusline-keys.title")}</Sub>
              <Table
                caption={t("statusline.statusline-keys.caption")}
                columns={[
                  { key: "key", header: t("statusline.statusline-keys.columns.key") },
                  { key: "accepts", header: t("statusline.statusline-keys.columns.accepts") },
                  { key: "meaning", header: t("statusline.statusline-keys.columns.meaning") },
                ]}
                rows={STATUSLINE_KEYS.map((key) => ({
                  key: <Code>{key}</Code>,
                  accepts: t.rich(`statusline.statusline-keys.rows.${key}.accepts`, { code }),
                  meaning: t.rich(`statusline.statusline-keys.rows.${key}.meaning`, { code }),
                }))}
              />
              <Callout tone="key" title={t("statusline.calloutTitle")}>
                {t.rich("statusline.calloutBody", { code })}
              </Callout>
              <Sub id="statusline-commands">{t("statusline.statusline-commands.title")}</Sub>
              <CodeBlock
                label={t("statusline.capturedLabel", { date: CAPTURED_ON })}
                code={`${configCapture.command}\n${configCapture.output}`}
              />
              <P>{t.rich("statusline.statusline-commands.oneKey", { code })}</P>
              <CodeBlock
                code={`openlimiter config set statusline.order codex,claude
statusline.order=codex,claude

openlimiter config set statusline.meters all
statusline.meters=all

openlimiter config set statusline.width 12
openlimiter config: statusline.width must be a whole number from 40 to 400.

openlimiter config set statusline.theme dark
openlimiter config: unknown statusline key. Known keys: order, meters, width, rows, bars, color.`}
              />
              <P>{t.rich("statusline.statusline-commands.reinit", { code })}</P>
              <Sub id="statusline-stacking">{t("statusline.statusline-stacking.title")}</Sub>
              <P>{t("statusline.statusline-stacking.body")}</P>
              <CodeBlock
                label={t("statusline.capturedFixturesLabel", { date: CAPTURED_ON })}
                code={`${statuslineNarrowCapture.command}\n${statuslineNarrowCapture.output}`}
              />
              <Sub id="statusline-plain">{t("statusline.statusline-plain.title")}</Sub>
              <P>{t.rich("statusline.statusline-plain.body", { code })}</P>
              <CodeBlock
                label={t("statusline.capturedFixturesLabel", { date: CAPTURED_ON })}
                code={`${statuslinePlainCapture.command}\n${statuslinePlainCapture.output}`}
              />
            </>
          ),
        },
        {
          id: "claude-code",
          title: t("claude-code.title"),
          body: (
            <>
              <P>{t("claude-code.intro")}</P>
              <CodeBlock
                label="settings.json"
                code={`{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js statusline"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js hook"
          }
        ]
      }
    ]
  }
}`}
              />
              <Sub id="which-writes">{t("claude-code.which-writes.title")}</Sub>
              <P>{t("claude-code.which-writes.body")}</P>
            </>
          ),
        },
        {
          id: "credentials",
          title: t("credentials.title"),
          body: (
            <>
              <Callout tone="key" title={t("credentials.calloutTitle")}>
                {t("credentials.calloutBody")}
              </Callout>
              <P>{t.rich("credentials.stub", { code })}</P>
            </>
          ),
        },
        {
          id: "detection",
          title: t("detection.title"),
          body: (
            <>
              <P>{t.rich("detection.intro", { code })}</P>
              <CodeBlock
                label={t("detection.terminalLabel")}
                code={`openlimiter doctor
CONNECTOR DETECTED FRESHNESS DRIFT
claude no unknown UNVERIFIED
openrouter no unknown UNVERIFIED
codex no unknown UNVERIFIED
antigravity no unknown UNVERIFIED
opencode no unknown UNVERIFIED
manual yes fresh UNVERIFIED
CACHE ok DROPPED 0`}
              />
              <P>{t("detection.corrupt")}</P>
            </>
          ),
        },
      ]}
    />
  );
}
