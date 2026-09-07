import type { Metadata } from "next";
import { PairFlow } from "./pair-flow";
import { BrandLockup } from "@/components/brand";

/**
 * The page a phone lands on after scanning the desktop's QR code.
 *
 * It is deliberately out of every index: the address is only ever reached by
 * scanning a code that lives for two minutes, and a search result pointing at
 * it could only ever be a dead end. The code itself arrives in the URL
 * fragment, which no server ever sees, so this page is static and everything
 * that matters happens in the browser.
 */

export const metadata: Metadata = {
  title: "Pair this phone",
  description:
    "Finish pairing this phone with the OpenLimiter desktop application. The code lives for two minutes and the desktop has to approve it.",
  alternates: { canonical: "/app/pair" },
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  /*
   * Nothing that leaves this page may carry its address. The pairing code
   * arrives in the fragment, which a referrer would not include anyway, but
   * the rule is stated rather than assumed: no navigation, preload or asset
   * this page touches sends a referrer header at all.
   */
  referrer: "no-referrer",
};

export default function PairPage() {
  return (
    <main id="main" className="ol-shell mx-auto w-full max-w-md px-4 py-8">
      <div className="mb-8 flex items-center gap-3">
        <BrandLockup
          markClassName="h-7 w-7 flex-none text-brand"
          wordClassName="ol-product-wordmark text-lg"
        />
      </div>
      <PairFlow />
    </main>
  );
}
