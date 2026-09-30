import { useTranslations } from "next-intl";
import { ProductFigure } from "./device-frame";

export function PhonePanels() {
  const t = useTranslations("phonePanels");
  // The phone demonstrates its meters, then more providers and the Pro offer. Remote agent activity is not shipped.
  return (
    <div className="flex flex-wrap items-start justify-center gap-[var(--ol-space-5)]">
      <ProductFigure name="phone-1" alt={t("shots.meters.alt")} caption={t("shots.meters.label")} className="w-full max-w-80" />
      <ProductFigure name="phone-3" alt={t("shots.connections.alt")} caption={t("shots.connections.label")} className="hidden w-full max-w-80 md:block" />
    </div>
  );
}
