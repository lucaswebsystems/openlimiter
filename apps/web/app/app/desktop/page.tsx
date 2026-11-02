"use client";

import { useTranslations } from "next-intl";
import { BrandLockup } from "@/components/brand";

/**
 * Where the desktop app's sign in ends in the browser. The desktop receives
 * the login on its own loopback address, then sends the browser here so the
 * person lands on the live site instead of a bare 127.0.0.1 page.
 */
export default function DesktopSignedInPage() {
  const t = useTranslations("hub.desktopSignedIn");
  return (
    <main id="main" className="ol-shell mx-auto w-full max-w-md px-4 py-8">
      <div className="mb-8 flex items-center gap-3">
        <BrandLockup markClassName="h-7 w-7 flex-none text-brand" wordClassName="ol-product-wordmark text-lg" />
      </div>
      <section className="rounded-2xl border border-hairline bg-surface p-5" aria-live="polite">
        <h1 className="flex items-center gap-2 text-lg font-medium text-heading">
          <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full bg-accent-solid" />
          {t("title")}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">{t("body")}</p>
      </section>
    </main>
  );
}