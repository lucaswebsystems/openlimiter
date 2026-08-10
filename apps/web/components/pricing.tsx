import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ButtonLink, Chip, SectionHeading } from "./ui";
import { reveal, revealGroup } from "@/lib/motion";
import { LICENSE_URL, PRO_PRICE, PRO_REGULAR_PRICE, REPO_URL } from "@/lib/site";

/**
 * Pricing.
 *
 * The section exists to answer one question honestly: what costs money, and
 * what never will. The answer is a line, not a table. Everything that runs on
 * your own machine is free under Apache 2.0 and stays free. The only thing
 * that could ever be sold is a service that runs on somebody's servers, and
 * servers cost money whoever owns them.
 *
 * The rule this file is written under: **nothing here is for sale today.**
 * OpenLimiter Pro is not built. There is no checkout, no card form, no waiting
 * list and no email capture, and the card says so in its own heading rather
 * than in small print underneath. Every line in the Pro list is a service that
 * does not exist yet, which is why the list is marked once at the top rather
 * than pretending some of it is closer than the rest.
 *
 * The one line in the free list that is not shipped is marked in place, and it
 * is marked because it will be free when it lands, which is the whole reason
 * for listing it on that side of the section.
 *
 * THE TWO NUMBERS STAY IN CODE
 * ----------------------------
 * `PRO_PRICE` and `PRO_REGULAR_PRICE` are still read from lib/site.ts and are
 * passed into the sentence about them as arguments rather than being typed into
 * five catalogs. A price that could be edited in a translation is a price that
 * can disagree with itself in one language, and the rule about how these two
 * numbers may be described is the strictest rule on the site.
 */

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="mt-0.5 h-4 w-4 flex-none text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  );
}

function PlannedGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="mt-0.5 h-4 w-4 flex-none text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.75V12l2.75 1.75" />
    </svg>
  );
}

/**
 * The two lists, as identifiers.
 *
 * The order is the argument the section makes and is the same argument in every
 * language, so it lives here. Each identifier is a catalog key under
 * `pricing.free.lines` or `pricing.pro.lines`.
 *
 * `planned` marks the one free line that is not shipped. It is a fact about the
 * product rather than a word, so it stays in the code and only the chip's label
 * is read from the catalog.
 */
const FREE_LINES: readonly { id: string; planned?: boolean }[] = [
  { id: "connectors" },
  { id: "agentContext" },
  { id: "notifications", planned: true },
  { id: "themes" },
  { id: "cli" },
  { id: "ingestion" },
  { id: "noLimits" },
];

const PRO_LINES: readonly { id: string }[] = [
  { id: "sync" },
  { id: "push" },
  { id: "smartLimiter" },
  { id: "email" },
  { id: "deliveryRules" },
  { id: "history" },
  { id: "priority" },
  { id: "team" },
];

function PlanList({
  lines,
  glyph,
  label,
  plannedLabel,
}: {
  lines: readonly { id: string; planned?: boolean }[];
  glyph: "check" | "planned";
  label: (id: string) => string;
  plannedLabel: string;
}) {
  return (
    <ul className="mt-6 space-y-3">
      {lines.map((line) => (
        <li key={line.id} className="flex gap-3 text-sm leading-relaxed text-body">
          {glyph === "check" && line.planned !== true ? <CheckGlyph /> : <PlannedGlyph />}
          <span className="min-w-0">
            {label(line.id)}
            {line.planned === true && (
              <Chip tone="neutral" className="ml-2 align-middle">
                {plannedLabel}
              </Chip>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PlanCard({
  title,
  status,
  statusTone,
  lead,
  price,
  children,
  footnote,
}: {
  title: string;
  status: string;
  statusTone: "accent" | "neutral";
  lead: string;
  price: ReactNode;
  children: ReactNode;
  footnote: ReactNode;
}) {
  return (
    <div
      className="elev-1 relative flex flex-col overflow-hidden rounded-2xl border border-hairline bg-surface p-6 md:p-7"
      {...reveal}
    >
      <span aria-hidden="true" className="hairline-sheen" />
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xl font-medium text-heading">{title}</h3>
        <Chip tone={statusTone} dot={statusTone === "accent"} className="uppercase tracking-wider">
          {status}
        </Chip>
      </div>
      {price}
      <p className="mt-3 text-sm leading-relaxed text-muted">{lead}</p>
      <div className="flex-1">{children}</div>
      <div className="mt-7 border-t border-hairline pt-5 text-sm leading-relaxed text-muted">
        {footnote}
      </div>
    </div>
  );
}

export async function Pricing() {
  const t = await getTranslations("pricing");

  return (
    <section id="pricing" className="scroll-mt-8">
      <SectionHeading title={t("title")} lead={t("lead")} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" {...revealGroup}>
        <PlanCard
          title="OpenLimiter"
          status={t("free.status")}
          statusTone="accent"
          price={
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="text-4xl font-medium tracking-tight text-heading">
                {t("free.price")}
              </span>
              <span className="text-sm text-muted">{t("free.priceNote")}</span>
            </p>
          }
          lead={t("free.lead")}
          footnote={t.rich("free.footnote", {
            licence: (chunks) => (
              <a
                href={LICENSE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
              >
                {chunks}
              </a>
            ),
          })}
        >
          <PlanList
            lines={FREE_LINES}
            glyph="check"
            label={(id) => t(`free.lines.${id}`)}
            plannedLabel={t("plannedChip")}
          />
        </PlanCard>

        <PlanCard
          title="OpenLimiter Pro"
          status={t("pro.status")}
          statusTone="neutral"
          price={
            <>
              <p className="mt-4 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                {/* The planned regular price, shown struck through so the
                    founding price reads as the lower of the two. It is hidden
                    from assistive technology and restated in full below,
                    because a struck number read on its own sounds like a price
                    that was once charged, and this one never was. */}
                <span
                  aria-hidden="true"
                  className="text-lg font-medium text-muted line-through decoration-1"
                >
                  {PRO_REGULAR_PRICE}
                </span>
                <span className="text-4xl font-medium tracking-tight text-heading">
                  {PRO_PRICE}
                </span>
                <span className="text-sm text-muted">{t("pro.perMonth")}</span>
                <Chip tone="accent" className="uppercase tracking-wider">
                  {t("pro.foundingChip")}
                </Chip>
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {t("pro.priceNote", { regular: PRO_REGULAR_PRICE, founding: PRO_PRICE })}
              </p>
            </>
          }
          lead={t("pro.lead")}
          footnote={t("pro.footnote")}
        >
          <PlanList
            lines={PRO_LINES}
            glyph="planned"
            label={(id) => t(`pro.lines.${id}`)}
            plannedLabel={t("plannedChip")}
          />
        </PlanCard>
      </div>

      <div className="mt-6 flex flex-wrap gap-3" {...reveal}>
        <ButtonLink href="/docs/roadmap">{t("roadmapCta")}</ButtonLink>
        <ButtonLink href={REPO_URL} external>
          {t("sourceCta")}
        </ButtonLink>
      </div>
    </section>
  );
}
