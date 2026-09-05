import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Bullets, Callout, Code, DocLink, P, Table } from "@/components/docs/prose";
import { PageShell } from "@/components/page-shell";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";
import { reveal } from "@/lib/motion";
import { AUTHOR_EMAIL } from "@/lib/site";

/**
 * The privacy policy.
 *
 * WHY IT IS WRITTEN FROM THE DATA MAP AND NOT FROM A TEMPLATE
 * ----------------------------------------------------------
 * Every sentence below describes a flow that exists in the product, and each
 * one is traceable to the launch contract: the free snapshot retention window,
 * the rolling ninety day Pro history, the thirty day export only period after
 * Pro ends, the generic by default alert content, the provider key that never
 * leaves the operating system keyring, and the cookieless page count on this
 * website. A generic policy would have been quicker and would have claimed
 * things the code does not do, which is the one failure this page cannot have.
 *
 * WHY THE PROSE IS IN THE CATALOG
 * -------------------------------
 * The site is published in five languages, and a policy that only exists in
 * English is not a policy for four fifths of the readers it is shown to. So the
 * page holds the structure, the anchors and the order of the argument, and
 * `messages/*.json` holds every sentence, exactly as the documentation pages
 * work. What stays here is what is the same in all five: the section ids, the
 * table shape, and the two identifiers a reader sees verbatim.
 */

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "privacy" });

  return pageMetadata({
    title: t("title"),
    description: t("metaDescription"),
    route: "/privacy",
    locale,
  });
}

/** The processors, in the order the table lists them. */
const PROCESSOR_IDS = [
  "supabase",
  "vercel",
  "stripe",
  "resend",
  "github",
  "google",
  "push",
] as const;

/** The retention rows, in the order the table lists them. */
const RETENTION_IDS = [
  "local",
  "snapshots",
  "history",
  "afterPro",
  "backups",
  "alerts",
  "exports",
  "billing",
] as const;

/** A section of the policy, at the rhythm /terms already reads at. */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-hairline pt-8" {...reveal}>
      <h2 className="text-xl font-medium tracking-tight text-heading">{title}</h2>
      {children}
    </section>
  );
}

export default async function PrivacyPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("privacy");
  const code = (chunks: React.ReactNode) => <Code>{chunks}</Code>;

  return (
    <PageShell title={t("title")} lead={t("lead")}>
      <div className="max-w-3xl space-y-12">
        <Callout tone="key" title={t("summary.title")}>
          <Bullets
            items={[
              t("summary.bullets.local"),
              t("summary.bullets.account"),
              t("summary.bullets.sync"),
              t("summary.bullets.keys"),
              t("summary.bullets.website"),
              t("summary.bullets.sell"),
            ]}
          />
        </Callout>

        <Section title={t("local.title")}>
          <P>{t("local.body")}</P>
          <Bullets
            items={[
              t("local.bullets.reads"),
              t("local.bullets.credentials"),
              t("local.bullets.telemetry"),
              t("local.bullets.account"),
            ]}
          />
        </Section>

        <Section title={t("account.title")}>
          <P>{t("account.body")}</P>
          <Bullets
            items={[
              t("account.bullets.identity"),
              t("account.bullets.stored"),
              t("account.bullets.password"),
              t("account.bullets.devices"),
            ]}
          />
        </Section>

        <Section title={t("sync.title")}>
          <P>{t("sync.body")}</P>
          <Bullets
            items={[
              t("sync.bullets.fields"),
              t("sync.bullets.never"),
              t("sync.bullets.retention"),
              t("sync.bullets.off"),
            ]}
          />
        </Section>

        <Section title={t("history.title")}>
          <P>{t("history.body")}</P>
          <Bullets
            items={[
              t("history.bullets.window"),
              t("history.bullets.gaps"),
              t("history.bullets.afterPro"),
              t("history.bullets.local"),
            ]}
          />
        </Section>

        <Section title={t("alerts.title")}>
          <P>{t("alerts.body")}</P>
          <Bullets
            items={[
              t("alerts.bullets.generic"),
              t("alerts.bullets.detail"),
              t("alerts.bullets.push"),
              t("alerts.bullets.disable"),
            ]}
          />
        </Section>

        <Section title={t("spend.title")}>
          <P>{t("spend.body")}</P>
          <Bullets
            items={[
              t("spend.bullets.keyring"),
              t("spend.bullets.host"),
              t("spend.bullets.never"),
              t("spend.bullets.revoke"),
            ]}
          />
        </Section>

        <Section title={t("payments.title")}>
          <P>{t("payments.body")}</P>
          <Bullets
            items={[
              t("payments.bullets.stripe"),
              t("payments.bullets.tax"),
              t("payments.bullets.refund"),
              t("payments.bullets.records"),
            ]}
          />
        </Section>

        <Section title={t("website.title")}>
          <P>{t("website.body")}</P>
          <Bullets
            items={[
              t("website.bullets.counts"),
              t("website.bullets.cookies"),
              t("website.bullets.app"),
              t("website.bullets.language"),
            ]}
          />
        </Section>

        <Section title={t("processors.title")}>
          <P>{t("processors.intro")}</P>
          <Table
            caption={t("processors.caption")}
            columns={[
              { key: "who", header: t("processors.columns.who") },
              { key: "what", header: t("processors.columns.what") },
            ]}
            rows={PROCESSOR_IDS.map((id) => ({
              who: t(`processors.rows.${id}.who`),
              what: t(`processors.rows.${id}.what`),
            }))}
          />
        </Section>

        <Section title={t("bases.title")}>
          <P>{t("bases.body")}</P>
          <Bullets
            items={[
              t("bases.bullets.contract"),
              t("bases.bullets.consent"),
              t("bases.bullets.interests"),
              t("bases.bullets.legal"),
            ]}
          />
          <P>{t("bases.transfers")}</P>
        </Section>

        <Section title={t("retention.title")}>
          <P>{t("retention.intro")}</P>
          <Table
            caption={t("retention.caption")}
            columns={[
              { key: "what", header: t("retention.columns.what") },
              { key: "howLong", header: t("retention.columns.howLong") },
            ]}
            rows={RETENTION_IDS.map((id) => ({
              what: t(`retention.rows.${id}.what`),
              howLong: t(`retention.rows.${id}.howLong`),
            }))}
          />
        </Section>

        <Section title={t("rights.title")}>
          <P>{t("rights.body")}</P>
          <Bullets
            items={[
              t("rights.bullets.export"),
              t("rights.bullets.delete"),
              t("rights.bullets.devices"),
              t("rights.bullets.channels"),
              t("rights.bullets.withdraw"),
              t("rights.bullets.complain"),
            ]}
          />
          <P>{t.rich("rights.deletion", { code })}</P>
        </Section>

        <Section title={t("children.title")}>
          <P>{t("children.body")}</P>
        </Section>

        <Section title={t("changes.title")}>
          <P>{t("changes.body")}</P>
          <P>
            {t.rich("changes.contact", {
              mail: (chunks) => <DocLink href={`mailto:${AUTHOR_EMAIL}`}>{chunks}</DocLink>,
              terms: (chunks) => <DocLink href="/terms">{chunks}</DocLink>,
            })}
          </P>
          <P>{t("changes.updated")}</P>
        </Section>
      </div>
    </PageShell>
  );
}
