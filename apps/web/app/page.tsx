import { AgentContextExample } from "@/components/agent-context";
import { Faq } from "@/components/faq";
import { FinalCta } from "@/components/final-cta";
import { Hero } from "@/components/hero";
import { HeroProductVisual } from "@/components/hero-product-visual";
import { HowItConnects } from "@/components/how-it-connects";
import { HowItWorks } from "@/components/how-it-works";
import { Ingestion } from "@/components/ingestion";
import { OpenSource } from "@/components/open-source";
import { Pricing } from "@/components/pricing";
import { Providers } from "@/components/providers";
import { Roadmap } from "@/components/roadmap";

export default function Home() {
  return (
    <main id="main" className="bg-canvas">
      <Hero />
      <HeroProductVisual />
      <HowItWorks />
      <HowItConnects />
      <Providers />
      <AgentContextExample />
      <Ingestion />
      <OpenSource />
      <Roadmap />
      <Pricing />
      <Faq />
      <FinalCta />
    </main>
  );
}
