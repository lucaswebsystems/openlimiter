import Link from "next/link";
import { AboutCard } from "@/components/about-card";
import { BrandLockup } from "@/components/brand";
import { DeviceFrame } from "@/components/device-frame";
import { Faq, faqItems } from "@/components/faq";
import { Hero } from "@/components/hero";
import { IntegrationStrip } from "@/components/integration-strip";
import { JsonLd } from "@/components/json-ld";
import { Pricing } from "@/components/pricing";
import { RunsWhere } from "@/components/runs-where";
import { SHELL } from "@/components/ui";
import { WebApp } from "@/components/web-app";
import { WorksWith } from "@/components/works-with";
import {
  faqPageSchema,
  organizationSchema,
  softwareApplicationSchema,
  websiteSchema,
} from "@/lib/jsonld";
import { reveal } from "@/lib/motion";

/**
 * The home page.
 *
 * One column, one width, top to bottom. The header, the hero, the product
 * frame, every section below it and the footer all render inside SHELL, so the
 * page has a single left edge and a single right edge and no band is narrower
 * than the one above it. Sections sit 96 pixels apart.
 *
 * The order ends on price. Everything that explains the product runs first, the
 * questions come after it, and only then does the page ask for money, which is
 * the order a reader who has not decided yet actually reads in.
 *
 * A row that needs to run wider than its text, namely the sliding strip, uses
 * FULL_BLEED to cancel the shell's padding rather than inventing a width of its
 * own. There is no other exception anywhere on the page.
 *
 * Four structured data blocks open the page: who publishes it, what site it is,
 * what the software is, and the questions further down. They are built in
 * lib/jsonld.ts from the same constants the rest of the site reads, and the
 * questions are the very array the FAQ section renders, so nothing here can
 * describe a page that is not the one below it.
 */

/**
 * The two sections this page used to spend a screen each on.
 *
 * "Read, bound, hand over" walked through the agent context block, and "Fully
 * scriptable" walked through the command line, and between them they were most
 * of the page's word count for a reader who had already decided. Both stories
 * are told properly in the documentation and one of them is on a phone card
 * further up, so the page keeps one line and gives the screen back.
 */
function DocsLine() {
  return (
    <p className="text-sm leading-relaxed text-muted" {...reveal}>
      Both of those are written up in full:{" "}
      <Link
        href="/docs/agent-context"
        className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
      >
        what an agent is told
      </Link>{" "}
      and{" "}
      <Link
        href="/docs/cli"
        className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
      >
        every command it ships with
      </Link>
      .
    </p>
  );
}

function BridgeBand() {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 pb-16 pt-4" {...reveal}>
      <BrandLockup markClassName="h-6 w-6 flex-none text-brand" wordClassName="text-base" />
      <p className="text-center text-lg text-soft">
        When you step away from the desk, the numbers are still on your own disk.
      </p>
      <p className="text-center text-sm text-muted">
        Nothing had to be uploaded to make that true.
      </p>
    </div>
  );
}

export default function Home() {
  return (
    <main id="main">
      <JsonLd data={organizationSchema()} />
      <JsonLd data={websiteSchema()} />
      <JsonLd data={softwareApplicationSchema()} />
      <JsonLd data={faqPageSchema(faqItems)} />
      <Hero />
      <DeviceFrame />
      <BridgeBand />
      <div className={`${SHELL} pb-6 pt-4 md:pb-20 md:pt-16`}>
        <div className="space-y-24">
          <IntegrationStrip />
          <WorksWith />
          <RunsWhere />
          <WebApp />
          <DocsLine />
          <Faq />
          {/* Price last, after every question a reader could have had. It keeps
              its own anchor, which the header button and the pricing links in
              the documentation both point at. */}
          <Pricing />
          <AboutCard />
        </div>
      </div>
    </main>
  );
}
