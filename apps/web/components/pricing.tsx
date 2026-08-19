import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { ButtonLink, Chip, SectionHeading } from "./ui";
import { reveal, revealGroup } from "@/lib/motion";
import { LICENSE_URL, PRO_MONTHLY_PRICE, PRO_YEARLY_PRICE, REPO_URL } from "@/lib/site";

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
  { id: "alerts" },
  { id: "history" },
  { id: "routing" },
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
          statusTone="accent"
          price={
            <>
              <p className="mt-4 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="text-4xl font-medium tracking-tight text-heading">
                  {PRO_MONTHLY_PRICE}
                </span>
                <span className="text-sm text-muted">{t("pro.perMonth")}</span>
                <Chip tone="accent" className="uppercase tracking-wider">
                  {t("pro.trialChip")}
                </Chip>
              </p>
              <p className="mt-2 text-sm text-muted">
                {t("pro.or")} <strong>{PRO_YEARLY_PRICE}</strong> {t("pro.perYear")}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted">{t("pro.priceNote")}</p>
            </>
          }
          lead={t("pro.lead")}
          footnote={
            <div className="space-y-4">
              <p>{t("pro.footnote")}</p>
              <ButtonLink href="/pro" tone="primary">
                {t("pro.cta")}
              </ButtonLink>
            </div>
          }
        >
          <PlanList
            lines={PRO_LINES}
            glyph="check"
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
