import { CrossPlatform } from "@/components/cross-platform";
import { Faq } from "@/components/faq";
import { FinalCta } from "@/components/final-cta";
import { Footer } from "@/components/footer";
import { Hero } from "@/components/hero";
import { HowItWorks } from "@/components/how-it-works";
import { Limitations } from "@/components/limitations";
import { Nav } from "@/components/nav";
import { OpenSource } from "@/components/open-source";
import { Pricing } from "@/components/pricing";
import { Providers } from "@/components/providers";
import { Wedge } from "@/components/wedge";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Wedge />
        <HowItWorks />
        <Providers />
        <CrossPlatform />
        <OpenSource />
        <Pricing />
        <Limitations />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
