import { AgentContextExample } from "@/components/agent-context";
import { CrossPlatform } from "@/components/cross-platform";
import { Faq } from "@/components/faq";
import { FinalCta } from "@/components/final-cta";
import { Footer } from "@/components/footer";
import { Hero } from "@/components/hero";
import { HeroProductVisual } from "@/components/hero-product-visual";
import { HowItWorks } from "@/components/how-it-works";
import { Nav } from "@/components/nav";
import { OpenSource } from "@/components/open-source";
import { Pricing } from "@/components/pricing";
import { Providers } from "@/components/providers";

export default function Home() {
  return (
    <>
      <Nav />
      <main className="relative bg-canvas text-body">
        <Hero />
        <HeroProductVisual />
        <HowItWorks />
        <Providers />
        <AgentContextExample />
        <CrossPlatform />
        <OpenSource />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
