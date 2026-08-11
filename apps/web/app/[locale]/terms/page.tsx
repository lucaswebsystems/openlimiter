import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DocLink, P } from "@/components/docs/prose";
import { PageShell } from "@/components/page-shell";
import { type LocaleParams, pageLocale } from "@/i18n/params";
import { pageMetadata } from "@/lib/metadata";
import { reveal } from "@/lib/motion";
import { AUTHOR_EMAIL, LICENSE_URL } from "@/lib/site";

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

export default async function TermsPage({ params }: LocaleParams) {
  await pageLocale(params);
  const t = await getTranslations("terms");

  return (
    <PageShell title={t("title")} lead={t("lead")}>
      <div className="max-w-3xl space-y-12">
        <section className="border-t border-hairline pt-8" {...reveal}>
          <h2 className="text-xl font-medium tracking-tight text-heading">Acceptance</h2>
          <P>
            By accessing or using this website, you agree to these terms. If you do not agree,
            please stop using the website. Your use of the software is governed separately by
            its licence.
          </P>
        </section>

        <section className="border-t border-hairline pt-8" {...reveal}>
          <h2 className="text-xl font-medium tracking-tight text-heading">Software licence</h2>
          <P>
            OpenLimiter is free open source software made available under the{" "}
            <DocLink href={LICENSE_URL}>Apache License 2.0</DocLink>. That licence, rather than
            these website terms, governs your right to use, copy, modify, and distribute the
            software.
          </P>
        </section>

        <section className="border-t border-hairline pt-8" {...reveal}>
          <h2 className="text-xl font-medium tracking-tight text-heading">No warranty</h2>
          <P>
            The website and software are provided as is and as available. We do not promise that
            they will always be accurate, complete, secure, or available. To the fullest extent
            allowed by law, all warranties are disclaimed.
          </P>
        </section>

        <section className="border-t border-hairline pt-8" {...reveal}>
          <h2 className="text-xl font-medium tracking-tight text-heading">
            Limitation of liability
          </h2>
          <P>
            To the fullest extent allowed by law, Lucas Costa and the OpenLimiter contributors
            are not liable for any indirect, incidental, special, consequential, or punitive
            damages, or for lost data, profits, revenue, or opportunities, resulting from your use
            of, or inability to use, the website or software. Any liability that the law does not
            allow us to exclude is limited to the minimum amount the law permits.
          </P>
        </section>

        <section className="border-t border-hairline pt-8" {...reveal}>
          <h2 className="text-xl font-medium tracking-tight text-heading">External links</h2>
          <P>
            This website may link to services that OpenLimiter does not control. Those services
            have their own terms and privacy practices. We are not responsible for their content,
            availability, or conduct.
          </P>
        </section>

        <section className="border-t border-hairline pt-8" {...reveal}>
          <h2 className="text-xl font-medium tracking-tight text-heading">Changes to these terms</h2>
          <P>
            We may update these terms when the website, software, or applicable law changes. New
            terms take effect when they are published on this page. Continued use of the website
            after an update means that you accept the revised terms.
          </P>
        </section>

        <section className="border-t border-hairline pt-8" {...reveal}>
          <h2 className="text-xl font-medium tracking-tight text-heading">Contact</h2>
          <P>
            Questions about these terms may be sent to{" "}
            <DocLink href={`mailto:${AUTHOR_EMAIL}`}>{AUTHOR_EMAIL}</DocLink>.
          </P>
        </section>
      </div>
    </PageShell>
  );
}
