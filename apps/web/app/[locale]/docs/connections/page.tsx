import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, DocLink, P, Sub, Table } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/connections", await pageLocale(params));
}

/**
 * Source chip vocabulary: what the dashboard actually renders today.
 *
 * Quoted, not imported, from apps/web/app/app/language.ts: `sourceStateLabel`
 * for the chip word and `sourceStateSentence` for the meaning. That module
 * sits inside the dashboard's own module graph and is out of scope for this
 * page to depend on. If this table and language.ts ever disagree, language.ts
 * is right and this table is the bug.
 *
 * What is left here is the chip word itself, which is the label the dashboard
 * paints on screen, and the provider names beside it. Each meaning is a
 * sentence and now lives in the catalog under this row's `key`, so the English
 * value there is what a diff against `sourceStateSentence` compares.
 */
const SOURCE_CHIPS = [
  { key: "localCli", chip: "Local CLI", providers: "Claude" },
  {
    key: "importOnly",
    chip: "Import only",
    providers: "OpenRouter, Codex, Antigravity, OpenCode",
  },
  /* Manual is the one row whose provider cell is a phrase rather than a list of
     product names, so that cell comes from the catalog like the meanings do. */
  { key: "manual", chip: "Manual", providers: null },
] as const;

/**
 * The full connection vocabulary, quoted rather than imported.
 *
 * Source of truth: packages/core/src/connection-state.ts, export
 * `connectionSentence`. apps/web is deployed on its own and is not a member of
 * the pnpm workspace (see apps/web/app/app/engine/sync.mjs), so it cannot
 * import "@openlimiter/core" as a package. The browser mirror that works
 * around that for the dashboard, apps/web/app/app/engine/generated/core/
 * connection-state.ts, is generated for that dashboard specifically and is out
 * of scope for a docs page to depend on. If this table and the core module
 * ever disagree, the core module is right and this table is the bug: diff
 * `connectionSentence` against the English catalog values these keys point at.
 *
 * The state names are values the whole product shares and never translate, so
 * they stay here. Their sentences are prose and live in the catalog.
 */
const CONNECTION_STATE_ROWS = [
  { state: "NOT_CONFIGURED", key: "notConfigured" },
  { state: "DETECTED", key: "detected" },
  { state: "NEEDS_AUTH", key: "needsAuth" },
  { state: "READY_TO_ENABLE", key: "readyToEnable" },
  { state: "CONNECTING", key: "connecting" },
  { state: "CONNECTED", key: "connected" },
  { state: "DEGRADED", key: "degraded" },
  { state: "STALE", key: "stale" },
  { state: "AUTH_EXPIRED", key: "authExpired" },
  { state: "IMPORT_ONLY", key: "importOnly" },
  { state: "MANUAL", key: "manual" },
  { state: "UNSUPPORTED", key: "unsupported" },
  { state: "ERROR", key: "error" },
] as const;

export default async function ConnectionsPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Sentences come from the catalog, keyed by the anchor they render under, and
     each table row's prose by the row's own key above. */
  const t = await getTranslations("docs.pages.connections.sections");

  return (
    <DocArticle
      id="connections"
      sections={[
        {
          id: "chips",
          title: t("chips.title"),
          body: (
            <>
              <P>{t("chips.intro")}</P>
              <Table
                caption={t("chips.caption")}
                columns={[
                  { key: "chip", header: t("chips.columns.chip") },
                  { key: "providers", header: t("chips.columns.providers") },
                  { key: "meaning", header: t("chips.columns.meaning") },
                ]}
                rows={SOURCE_CHIPS.map((row) => ({
                  chip: <Code>{row.chip}</Code>,
                  providers: row.providers ?? t(`chips.rows.${row.key}.providers`),
                  meaning: t(`chips.rows.${row.key}.meaning`),
                }))}
              />
              <Callout tone="key" title={t("chips.calloutTitle")}>
                {t.rich("chips.calloutBody", {
                  code: (chunks) => <Code>{chunks}</Code>,
                  docs: (chunks) => <DocLink href="/docs/ingestion">{chunks}</DocLink>,
                })}
              </Callout>
            </>
          ),
        },
        {
          id: "vocabulary",
          title: t("vocabulary.title"),
          body: (
            <>
              <P>{t("vocabulary.intro")}</P>
              <Table
                caption={t("vocabulary.caption")}
                columns={[
                  { key: "state", header: t("vocabulary.columns.state") },
                  { key: "meaning", header: t("vocabulary.columns.meaning") },
                ]}
                rows={CONNECTION_STATE_ROWS.map((row) => ({
                  state: <Code>{row.state}</Code>,
                  meaning: t(`vocabulary.rows.${row.key}.meaning`),
                }))}
              />
              <Bullets
                items={[
                  t.rich("vocabulary.bullets.declared", {
                    code: (chunks) => <Code>{chunks}</Code>,
                  }),
                  t("vocabulary.bullets.lifecycle"),
                ]}
              />
              <Sub id="what-this-is-not-claiming">
                {t("vocabulary.what-this-is-not-claiming.title")}
              </Sub>
              <P>{t("vocabulary.what-this-is-not-claiming.body")}</P>
            </>
          ),
        },
        {
          id: "what-changes",
          title: t("what-changes.title"),
          body: (
            <>
              <P>{t("what-changes.intro")}</P>
              <P>
                {t.rich("what-changes.noReader", {
                  roadmap: (chunks) => <DocLink href="/docs/roadmap">{chunks}</DocLink>,
                  providers: (chunks) => <DocLink href="/docs/providers">{chunks}</DocLink>,
                })}
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
