import type { ReactNode } from "react";
import { ButtonLink, Chip, SectionHeading } from "./ui";
import { reveal, revealGroup } from "@/lib/motion";
import {
  LICENSE_URL,
  PRO_PRICE,
  PRO_PRICE_NOTE,
  PRO_REGULAR_PRICE,
  REPO_URL,
} from "@/lib/site";

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

interface PlanLine {
  readonly text: string;
  /** Set only where the line is not built, and the chip says so on the row. */
  readonly planned?: string;
}

const freeLines: readonly PlanLine[] = [
  { text: "Every connector, and every one added later" },
  { text: "The bounded agent context block and its routing advice" },
  {
    text: "Desktop notifications and sounds when a window nears its cap",
    planned: "planned",
  },
  { text: "Themes, in the desktop application and in the browser" },
  { text: "The full command line tool and every statusline setting" },
  { text: "All three ingestion paths: a connector, ingest, or manual entry" },
  { text: "No usage limit, no account, no feature locked behind anything" },
];

const proLines: readonly PlanLine[] = [
  { text: "Encrypted synchronisation of quota state across your own devices" },
  { text: "Push notifications to your phone when a window nears its cap" },
  {
    text: "Smart limiter: quota aware routing between your models, driven by live budget state",
  },
  { text: "Email alerts and a weekly digest" },
  { text: "Alert delivery rules, so a quiet hour stays quiet" },
  { text: "Hosted usage history and burn trends across every device" },
  { text: "Priority connector requests, so your provider gets built first" },
  { text: "A team dashboard tier, later than the rest" },
];

function PlanList({ lines, glyph }: { lines: readonly PlanLine[]; glyph: "check" | "planned" }) {
  return (
    <ul className="mt-6 space-y-3">
      {lines.map((line) => (
        <li key={line.text} className="flex gap-3 text-sm leading-relaxed text-body">
          {glyph === "check" && line.planned === undefined ? <CheckGlyph /> : <PlannedGlyph />}
          <span className="min-w-0">
            {line.text}
            {line.planned !== undefined && (
              <Chip tone="neutral" className="ml-2 align-middle">
                {line.planned}
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

export function Pricing() {
  return (
    <section id="pricing" className="scroll-mt-8">
      <SectionHeading
        title="Pricing"
        lead="Everything that runs on your machine is free, and that is not a launch offer. The only thing that could ever cost money is a service running on servers, because servers cost money to run."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" {...revealGroup}>
        <PlanCard
          title="OpenLimiter"
          status="available"
          statusTone="accent"
          price={
            <p className="mt-4 flex items-baseline gap-1.5">
              <span className="text-4xl font-medium tracking-tight text-heading">Free</span>
              <span className="text-sm text-muted">forever, and in the licence</span>
            </p>
          }
          lead="The whole local product, for everybody, with no account anywhere in it."
          footnote={
            <>
              Open source under{" "}
              <a
                href={LICENSE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
              >
                Apache 2.0
              </a>
              , so this cannot be taken away later. The licence is the promise.
            </>
          }
        >
          <PlanList lines={freeLines} glyph="check" />
        </PlanCard>

        <PlanCard
          title="OpenLimiter Pro"
          status="not built"
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
                <span className="text-sm text-muted">a month</span>
                <Chip tone="accent" className="uppercase tracking-wider">
                  founding price
                </Chip>
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted">{PRO_PRICE_NOTE}</p>
            </>
          }
          lead="Services that run on servers rather than on your machine. Every line below is coming and none of it exists yet: there is no checkout, no card form and no waiting list."
          footnote="Nothing local ever moves behind this plan. Pro sells servers and service, not switches."
        >
          <PlanList lines={proLines} glyph="planned" />
        </PlanCard>
      </div>

      <div className="mt-6 flex flex-wrap gap-3" {...reveal}>
        <ButtonLink href="/docs/roadmap">What is actually planned</ButtonLink>
        <ButtonLink href={REPO_URL} external>
          Read the source
        </ButtonLink>
      </div>
    </section>
  );
}
