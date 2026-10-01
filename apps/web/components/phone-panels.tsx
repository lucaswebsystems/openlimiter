import { useTranslations } from "next-intl";
import { ProductFigure } from "./device-frame";

export function PhonePanels() {
  const t = useTranslations("phonePanels");
  const shots = [
    { name: "phone-1", copy: "meters" },
    { name: "phone-2", copy: "providers" },
    { name: "phone-3", copy: "connections" },
    { name: "phone-4", copy: "pro" },
  ] as const;
  return (
    <div className="grid w-full grid-cols-1 items-start gap-[var(--ol-space-5)] sm:grid-cols-2 lg:grid-cols-4">
      {shots.map(({ name, copy }) => (
        <ProductFigure key={name} name={name} alt={t(`shots.${copy}.alt`)} caption={t(`shots.${copy}.label`)} className="w-full" />
      ))}
    </div>
  );
}
