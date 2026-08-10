import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { DocArticle } from "@/components/docs/doc-article";
import {
  Bullets,
  Callout,
  Code,
  DocLink,
  ExternalLink,
  P,
  Sub,
} from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";
import { REPO_URL } from "@/lib/site";
import { type LocaleParams, pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: LocaleParams): Promise<Metadata> {
  return docMetadata("/docs/security", await pageLocale(params));
}

export default async function SecurityPage({ params }: LocaleParams) {
  await pageLocale(params);
  /* Sentences come from the catalog, keyed by the anchor they render under. Each
     guarantee opens on an emphasised clause, so the bullet stays one message
     with a tag rather than a bold fragment glued to a sentence. */
  const t = await getTranslations("docs.pages.security.sections");
  const code = (chunks: ReactNode) => <Code>{chunks}</Code>;
  const strong = (chunks: ReactNode) => <strong className="font-medium">{chunks}</strong>;

  return (
    <DocArticle
      id="security"
      sections={[
        {
          id: "guarantees",
          title: t("guarantees.title"),
          body: (
            <>
              <Callout tone="key" title={t("guarantees.calloutTitle")}>
                <Bullets
                  items={[
                    t.rich("guarantees.bullets.noServer", { strong }),
                    t.rich("guarantees.bullets.noTelemetry", { strong }),
                    t.rich("guarantees.bullets.hookNoNetwork", { strong }),
                    t.rich("guarantees.bullets.noEgress", { strong }),
                    t.rich("guarantees.bullets.unknownNeverZero", { strong }),
                    t.rich("guarantees.bullets.readOnlyArtifacts", { strong }),
                  ]}
                />
              </Callout>
            </>
          ),
        },
        {
          id: "injection-boundary",
          title: t("injection-boundary.title"),
          body: (
            <>
              <P>{t("injection-boundary.intro")}</P>
              <Bullets
                items={[
                  t("injection-boundary.bullets.parsers"),
                  t("injection-boundary.bullets.advice"),
                  t("injection-boundary.bullets.adapter"),
                  t("injection-boundary.bullets.unknown"),
                ]}
              />
              <P>
                {t.rich("injection-boundary.exactBlock", {
                  docs: (chunks) => <DocLink href="/docs/agent-context">{chunks}</DocLink>,
                })}
              </P>
            </>
          ),
        },
        {
          id: "secrets",
          title: t("secrets.title"),
          body: (
            <>
              <P>{t("secrets.intro")}</P>
              <Sub id="local-state">{t("secrets.local-state.title")}</Sub>
              <P>
                {t.rich("secrets.local-state.body", {
                  docs: (chunks) => <DocLink href="/docs/configuration">{chunks}</DocLink>,
                })}
              </P>
            </>
          ),
        },
        {
          id: "honest-limits",
          title: t("honest-limits.title"),
          body: (
            <>
              <Callout tone="note" title={t("honest-limits.calloutTitle")}>
                <Bullets
                  items={[
                    t("honest-limits.bullets.noOfficialApi"),
                    t.rich("honest-limits.bullets.unverified", { code }),
                    t("honest-limits.bullets.opencode"),
                    t("honest-limits.bullets.adviceOnly"),
                  ]}
                />
              </Callout>
            </>
          ),
        },
        {
          id: "future-egress",
          title: t("future-egress.title"),
          body: (
            <>
              <P>{t("future-egress.intro")}</P>
              <Bullets
                items={[
                  t("future-egress.bullets.oneHost"),
                  t("future-egress.bullets.transport"),
                  t("future-egress.bullets.bounds"),
                  t("future-egress.bullets.status"),
                  t("future-egress.bullets.sendNothing"),
                ]}
              />
            </>
          ),
        },
        {
          id: "reporting",
          title: t("reporting.title"),
          body: (
            <>
              <P>{t.rich("reporting.address", { code })}</P>
              <P>
                {t.rich("reporting.scope", {
                  policy: (chunks) => (
                    <ExternalLink href={`${REPO_URL}/blob/main/SECURITY.md`}>{chunks}</ExternalLink>
                  ),
                  threat: (chunks) => (
                    <ExternalLink href={`${REPO_URL}/blob/main/THREAT_MODEL.md`}>
                      {chunks}
                    </ExternalLink>
                  ),
                })}
              </P>
              <P>{t("reporting.supported")}</P>
            </>
          ),
        },
      ]}
    />
  );
}
