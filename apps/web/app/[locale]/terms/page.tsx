import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocLink, P } from "@/components/docs/prose";
import { PageShell } from "@/components/page-shell";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";
import { reveal } from "@/lib/motion";
import { AUTHOR_EMAIL, LICENSE_URL } from "@/lib/site";

/**
 * The terms and conditions.
 *
 * WHY THE PROSE MOVED INTO THE CATALOG
 * ------------------------------------
 * This page used to hold its sentences as literals, so a reader on the German
 * or Japanese site met a German heading over an English contract. Terms are the
 * last thing that should only exist in one language, so the sections are named
 * here and written in `messages/*.json`, the way every documentation page on
 * this site already works.
 *
 * WHAT THE SUBSCRIPTION SECTIONS ARE FOR
 * --------------------------------------
 * Selling Pro adds obligations a website licence page never had: what is being
 * bought, who charges for it, how it is cancelled, when money comes back, and
 * what happens when a payment fails. Each of those has one section, and each
 * one states the same rule the billing contract implements, including the
 * fourteen day full refund and the fixed seventy two hour grace after a first
 * failed payment that retries never extend.
 */

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  const locale = await pageLocale(params);
  const t = await getTranslations({ locale, namespace: "terms" });

  return pageMetadata({
    title: t("title"),
    description: t("metaDescription"),
    route: "/terms",
    locale,
  });
}

/**
 * The sections that are one heading over one paragraph, in reading order.
 *
 * Acceptance and the licence open the page and carry a link between them, so
 * they are rendered by name below. This list is everything after them that is
 * plain prose.
 */
const PLAIN_SECTIONS = [
  "account",
  "billing",
  "cancellation",
  "refund",
  "failedPayment",
  "warranty",
  "liability",
  "links",
  "changes",
] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-hairline pt-8" {...reveal}>
      <h2 className="text-xl font-medium tracking-tight text-heading">{title}</h2>
      {children}
    </section>
  );
}

export default async function TermsPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("terms");

  return (
    <PageShell title={t("title")} lead={t("lead")}>
      <div className="max-w-3xl space-y-12">
        <Section title={t("sections.acceptance.title")}>
          <P>{t("sections.acceptance.body")}</P>
        </Section>

        {/* The licence section carries a link, so it is written out rather than
           taken from the plain list above. It stays in the position the page
           has always read in, directly after acceptance. */}
        <Section title={t("sections.licence.title")}>
          <P>
            {t.rich("sections.licence.body", {
              licence: (chunks) => <DocLink href={LICENSE_URL}>{chunks}</DocLink>,
            })}
          </P>
        </Section>

        {PLAIN_SECTIONS.map((id) => (
          <Section key={id} title={t(`sections.${id}.title`)}>
            <P>{t(`sections.${id}.body`)}</P>
          </Section>
        ))}

        <Section title={t("sections.privacy.title")}>
          <P>
            {t.rich("sections.privacy.body", {
              privacy: (chunks) => <DocLink href="/privacy">{chunks}</DocLink>,
            })}
          </P>
        </Section>

        <Section title={t("sections.contact.title")}>
          <P>
            {t.rich("sections.contact.body", {
              mail: (chunks) => <DocLink href={`mailto:${AUTHOR_EMAIL}`}>{chunks}</DocLink>,
            })}
          </P>
        </Section>
      </div>
    </PageShell>
  );
}
