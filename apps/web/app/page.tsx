import { AboutCard } from "@/components/about-card";
import { AgentContext } from "@/components/agent-context";
import { BrandMark } from "@/components/brand";
import { DeviceFrame } from "@/components/device-frame";
import { Faq } from "@/components/faq";
import { Hero } from "@/components/hero";
import { IntegrationStrip } from "@/components/integration-strip";
import { RunsWhere } from "@/components/runs-where";
import { Scriptable } from "@/components/scriptable";
import { WebApp } from "@/components/web-app";
import { WorksWith } from "@/components/works-with";

/**
 * The home page.
 *
 * Three bands, in this order and at these widths, which is the whole layout:
 *
 *   1. The hero and the product frame run to 1280 pixels, the wide measure.
 *   2. A short centred band bridges into the content.
 *   3. Everything after it runs to 1024 pixels with 80 pixels of padding, so
 *      the reading column is 864 wide, and sections sit 96 pixels apart.
 *
 * The header above renders inside the same 1280 column, so the wordmark, the
 * headline and the frame all start on the same left edge.
 */

function BridgeBand() {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 pb-16 pt-4">
      <BrandMark className="h-6 w-6 text-muted" />
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
      <div className="mx-auto max-w-5xl p-6 md:p-20 md:pt-40">
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
