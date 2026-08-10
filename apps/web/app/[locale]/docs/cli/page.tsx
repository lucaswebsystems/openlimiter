import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub, Table } from "@/components/docs/prose";
import {
  CAPTURED_ON,
  configCapture,
  demoCapture,
  statuslineAllMetersCapture,
  statuslineCapture,
  statuslineNarrowCapture,
  statuslinePlainCapture,
} from "@/lib/cli-capture";
import { docMetadata } from "@/lib/metadata";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/cli", await pageLocale(params));
}

export default async function CliPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Sentences come from the catalog, keyed by the anchor they render under. The
     command names heading each block are the commands themselves, so they stay
     here beside their transcripts, their flags and their exit codes. */
  const t = await getTranslations("docs.pages.cli.sections");
  const code = (chunks: ReactNode) => <Code>{chunks}</Code>;

  return (
    <DocArticle
      id="cli"
      sections={[
        {
          id: "overview",
          title: t("overview.title"),
          body: (
            <>
              <CodeBlock
                label="openlimiter help"
                code={`openlimiter init
openlimiter snapshot [--refresh]
openlimiter statusline
openlimiter hook [--dry-run]
openlimiter ingest [--provider <id>] [--payload <json>]
openlimiter config get statusline[.<key>]
openlimiter config set statusline.<key> <value>
openlimiter doctor
openlimiter demo
openlimiter export
openlimiter serve [--port <n>] [--host <address>] [--no-qr]

statusline keys: order, meters, width, rows, bars, color.
statusline and ingest read JSON from standard input when it is piped in.
Exit codes: 0 success, 1 failure, 2 usage, 3 no bounded quota data.`}
              />
              <P>{t.rich("overview.install", { code })}</P>
            </>
          ),
        },
        {
          id: "commands",
          title: t("commands.title"),
          body: (
            <>
              <Sub id="init">init</Sub>
              <P>{t("commands.init.body")}</P>
              <CodeBlock code={`openlimiter init
Configuration saved. Detected: manual`} />

              <Sub id="snapshot">snapshot</Sub>
              <P>{t.rich("commands.snapshot.intro", { code })}</P>
              <P>{t.rich("commands.snapshot.columns", { code })}</P>
              <CodeBlock
                label={t("commands.snapshot.syntheticLabel")}
                code={`openlimiter snapshot
PROVIDER METER BAR USAGE AMOUNT STATE RESET IN
CLAUDE FIVE_HOUR ####...... 42.00PERCENT NONE fresh 2026-08-10T04:00:32.969Z 5h0m
CLAUDE SEVEN_DAY ######.... 64.00PERCENT NONE fresh 2026-08-16T23:00:32.969Z 7d0h
OPENROUTER CREDITS ######.... 62.35PERCENT $12.47/$20.00 fresh NONE NONE`}
              />
              <P>{t("commands.snapshot.failures")}</P>

              <Sub id="statusline">statusline</Sub>
              <P>{t("commands.statusline.intro")}</P>
              <P>{t("commands.statusline.cells")}</P>
              {/* The capture date is a real value from lib/cli-capture.ts, so the
                  caption takes it as an argument rather than spelling it out. */}
              <CodeBlock
                label={t("commands.capturedFixturesLabel", { date: CAPTURED_ON })}
                code={`${statuslineCapture.command}\n${statuslineCapture.output}`}
              />
              <P>{t.rich("commands.statusline.order", { code })}</P>
              <CodeBlock
                label={t("commands.capturedFixturesLabel", { date: CAPTURED_ON })}
                code={`${statuslineAllMetersCapture.command}\n${statuslineAllMetersCapture.output}`}
              />
              <P>{t("commands.statusline.stacking")}</P>
              <CodeBlock
                label={t("commands.capturedFixturesLabel", { date: CAPTURED_ON })}
                code={`${statuslineNarrowCapture.command}\n${statuslineNarrowCapture.output}`}
              />
              <Callout tone="key" title={t("commands.statusline.calloutTitle")}>
                {t.rich("commands.statusline.calloutBody", { code })}
              </Callout>
              <CodeBlock
                label={t("commands.capturedFixturesLabel", { date: CAPTURED_ON })}
                code={`${statuslinePlainCapture.command}\n${statuslinePlainCapture.output}`}
              />

              <Sub id="config">config</Sub>
              <P>
                {t.rich("commands.config.body", {
                  docs: (chunks) => <DocLink href="/docs/configuration">{chunks}</DocLink>,
                })}
              </P>
              <CodeBlock
                label={t("commands.capturedLabel", { date: CAPTURED_ON })}
                code={`${configCapture.command}\n${configCapture.output}`}
              />
              <CodeBlock
                code={`openlimiter config set statusline.width 200
statusline.width=200

openlimiter config set statusline.rows 3
openlimiter config: statusline.rows must be 1 or 2.`}
              />

              <Sub id="hook">hook</Sub>
              <P>
                {t.rich("commands.hook.body", {
                  docs: (chunks) => <DocLink href="/docs/agent-context">{chunks}</DocLink>,
                })}
              </P>

              <Sub id="ingest">ingest</Sub>
              <P>{t.rich("commands.ingest.body", { code })}</P>
              <CodeBlock
                code={`openlimiter ingest --payload '{"meters":[{"name":"AGENT_BUDGET","used_percent":12.5,"reset_at":"2026-08-09T13:11:30.141Z"}]}'
Ingested 1 bounded meters. Cached meters: 3.`}
              />

              <Sub id="doctor">doctor</Sub>
              <P>{t.rich("commands.doctor.body", { code })}</P>

              <Sub id="demo">demo</Sub>
              <P>{t("commands.demo.body")}</P>
              <CodeBlock
                label={t("commands.capturedFixturesLabel", { date: CAPTURED_ON })}
                code={`${demoCapture.command}\n${demoCapture.output}`}
              />

              <Sub id="export">export</Sub>
              <P>{t("commands.export.body")}</P>

              <Sub id="serve">serve</Sub>
              <P>{t.rich("commands.serve.body", { code })}</P>
              <Callout tone="key" title={t("commands.serve.calloutTitle")}>
                {t("commands.serve.calloutBody")}
              </Callout>
            </>
          ),
        },
        {
          id: "exit-codes",
          title: t("exit-codes.title"),
          body: (
            <>
              <Table
                caption={t("exit-codes.caption")}
                columns={[
                  { key: "code", header: t("exit-codes.columns.code") },
                  { key: "meaning", header: t("exit-codes.columns.meaning") },
                ]}
                /* The codes are the numbers themselves, so only the meaning of
                   each one is a sentence. Named rather than numbered, because a
                   key that reads as an array index invites keying by position. */
                rows={[
                  { code: <Code>0</Code>, meaning: t("exit-codes.rows.success") },
                  { code: <Code>1</Code>, meaning: t("exit-codes.rows.failure") },
                  { code: <Code>2</Code>, meaning: t("exit-codes.rows.usage") },
                  { code: <Code>3</Code>, meaning: t("exit-codes.rows.noData") },
                ]}
              />
              <Callout tone="key" title={t("exit-codes.calloutTitle")}>
                {t("exit-codes.calloutBody")}
              </Callout>
            </>
          ),
        },
        {
          id: "notes",
          title: t("notes.title"),
          body: (
            <Bullets
              items={[
                t("notes.bullets.stdin"),
                t("notes.bullets.truncated"),
                t.rich("notes.bullets.flags", { code }),
                t("notes.bullets.noNetwork"),
              ]}
            />
          ),
        },
      ]}
    />
  );
}
