import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Chip, SectionHeading } from "./ui";
import { reveal, revealGroup } from "@/lib/motion";
import { LICENSE_URL, PRO_MONTHLY_PRICE, PRO_YEARLY_PRICE } from "@/lib/site";

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
const FREE_LINES: readonly { id: string }[] = [
  { id: "connectors" },
  { id: "sync" },
  { id: "oneAccount" },
  { id: "noLimits" },
];

const PRO_LINES: readonly { id: string }[] = [
  { id: "alerts" },
  { id: "themes" },
  { id: "multiSubscription" },
  { id: "heavyApi" },
  { id: "history" },
  { id: "routing" },
];

function PlanList({
  lines,
  label,
}: {
  lines: readonly { id: string }[];
  label: (id: string) => string;
}) {
  return (
    <ul className="mt-6 space-y-3">
      {lines.map((line) => (
        <li key={line.id} className="flex gap-3 text-sm leading-relaxed text-body">
          <CheckGlyph />
          <span className="min-w-0">{label(line.id)}</span>
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
            label={(id) => t(`free.lines.${id}`)}
          />
        </PlanCard>

        <PlanCard
          title="OpenLimiter Pro"
          status={t("pro.comingSoonStatus")}
          statusTone="neutral"
          price={
            <>
              <p className="mt-4 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="text-4xl font-medium tracking-tight text-heading">
                  {PRO_MONTHLY_PRICE}
                </span>
                <span className="text-sm text-muted">{t("pro.perMonth")}</span>
              </p>
              <p className="mt-2 text-sm text-muted">
                {t("pro.or")} <strong>{PRO_YEARLY_PRICE}</strong> {t("pro.perYear")}
              </p>
            </>
          }
          lead={t("pro.lead")}
          footnote={
            <Chip tone="neutral">{t("pro.comingSoonCta")}</Chip>
          }
        >
          <PlanList
            lines={PRO_LINES}
            label={(id) => t(`pro.lines.${id}`)}
          />
          {/* The two sentences a reader needs before they can judge the list:
             which credential the API spend beta actually requires, and what
             happens to the money if the plan is not what they hoped. Both use
             the card's own muted body style rather than introducing a new one,
             because this wave is copy and the styleboard gate is still open. */}
          <p className="mt-6 text-sm leading-relaxed text-muted">{t("pro.eligibility")}</p>
          <p className="mt-3 text-sm leading-relaxed text-muted">{t("pro.refund")}</p>
        </PlanCard>
      </div>
    </section>
  );
}
