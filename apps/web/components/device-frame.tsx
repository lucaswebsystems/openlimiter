"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { SectionHeading, SHELL } from "./ui";
import { reveal } from "@/lib/motion";

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function readTheme() {
  return document.documentElement.dataset.theme ?? null;
}

// Dimensions describe the supplied captures, not an upscaled derivative.
export const PRODUCT_SHOTS = {
  "desktop-app": { width: 2560, height: 1600, maxWidth: 1280 },
  "desktop-home": { width: 2000, height: 1520, maxWidth: 1000 },
  "desktop-connect": { width: 2000, height: 1520, maxWidth: 1000 },
  "desktop-settings": { width: 2000, height: 1520, maxWidth: 1000 },
  "edge-tab": { width: 1120, height: 1178, maxWidth: 560 },
  "edge-panel": { width: 1120, height: 1178, maxWidth: 560 },
  "terminal-statusline": { width: 2400, height: 600, maxWidth: 1200 },
  "phone-1": { width: 1170, height: 2532, maxWidth: 390 },
  "phone-2": { width: 1170, height: 2532, maxWidth: 390 },
  "phone-3": { width: 1170, height: 2532, maxWidth: 390 },
  "phone-4": { width: 1170, height: 2532, maxWidth: 390 },
} as const;

export type ProductShotName = keyof typeof PRODUCT_SHOTS;

export function ProductShot({ name, alt }: { name: ProductShotName; alt: string }) {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => null);
  const shot = PRODUCT_SHOTS[name];
  const phone = name.startsWith("phone-");
  const srcSet = (light: boolean) => {
    const path = `/screenshots/${name}${light ? "-light" : ""}`;
    return `${path}@1x.webp 1x, ${path}@2x.webp 2x${phone ? `, ${path}@3x.webp 3x` : ""}`;
  };
  return (
    <div className="elev-1 mx-auto w-full overflow-hidden rounded-xl border border-hairline bg-frame p-[var(--ol-space-2)]" style={{ maxWidth: shot.maxWidth }}>
      <picture>
        {/* The site is dark until the reader picks light (globals.css consults
            only the attribute), so no attribute means the dark pictures too. */}
        <source type="image/webp" media={theme === "light" ? "all" : "not all"} srcSet={srcSet(true)} />
        <source type="image/webp" srcSet={srcSet(false)} />
        {/* One image per capture: hidden theme images cannot compete for priority. */}
        <img className="h-auto w-full rounded-lg" src={`/screenshots/${name}${theme === "light" ? "-light" : ""}.png`} alt={alt} width={shot.width} height={shot.height} loading="lazy" decoding="async" />
      </picture>
    </div>
  );
}

export function ProductFigure({ name, alt, caption, className = "" }: { name: ProductShotName; alt: string; caption: string; className?: string }) {
  return (
    <figure className={`min-w-0 text-center ${className}`}>
      <ProductShot name={name} alt={alt} />
      <ProductCaption caption={caption} />
    </figure>
  );
}

export function ProductCaption({ caption }: { caption: string }) {
  const t = useTranslations("common");
  return (
    <figcaption className="mx-auto mt-[var(--ol-space-4)] flex max-w-2xl flex-col items-center gap-[var(--ol-space-2)] text-sm leading-relaxed text-body">
      <p>{caption}</p>
      <span className="inline-flex items-center justify-center rounded-full border border-hairline bg-raised px-[var(--ol-space-3)] py-[var(--ol-space-1)] text-xs font-medium text-heading">{t("demoData")}</span>
    </figcaption>
  );
}

export function DeviceFrame() {
  const t = useTranslations("deviceFrame");
  return (
    <section className={`${SHELL} relative py-[var(--ol-space-7)] text-center`}>
      <SectionHeading title={t("title")} lead={t("lead")} />
      <div {...reveal}>
        {/* The desk, as on the site before 2026-09-29; the full Home, Agents
            included, follows in the Busy, waiting or done section. */}
        <ProductFigure name="desktop-app" alt={t("screenshot.alt")} caption={t("caption")} />
      </div>
    </section>
  );
}
