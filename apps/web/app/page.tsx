import { AboutCard } from "@/components/about-card";
import { AgentContext } from "@/components/agent-context";
import { BrandMark } from "@/components/brand";
import { DeviceFrame } from "@/components/device-frame";
import { Faq } from "@/components/faq";
import { Hero } from "@/components/hero";
import { IntegrationStrip } from "@/components/integration-strip";
import { RunsWhere } from "@/components/runs-where";
import { Scriptable } from "@/components/scriptable";
import { SHELL } from "@/components/ui";
import { WebApp } from "@/components/web-app";
import { WorksWith } from "@/components/works-with";
import { reveal } from "@/lib/motion";

/**
 * The home page.
 *
 * One column, one width, top to bottom. The header, the hero, the product
 * frame, every section below it and the footer all render inside SHELL, so the
 * page has a single left edge and a single right edge and no band is narrower
 * than the one above it. Sections sit 96 pixels apart.
 *
 * A row that needs to run wider than its text, namely the sliding strip, uses
 * FULL_BLEED to cancel the shell's padding rather than inventing a width of its
 * own. There is no other exception anywhere on the page.
 */

function BridgeBand() {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 pb-16 pt-4" {...reveal}>
      <BrandMark className="h-7 w-7 text-brand" />
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
      <Hero />
      <DeviceFrame />
      <BridgeBand />
      <div className={`${SHELL} pb-6 pt-4 md:pb-20 md:pt-16`}>
        <div className="space-y-24">
          <IntegrationStrip />
          <WorksWith />
          <RunsWhere />
          <WebApp />
          <AgentContext />
          <Scriptable />
          <Faq />
          <AboutCard />
        </div>
      </div>
    </main>
  );
}
