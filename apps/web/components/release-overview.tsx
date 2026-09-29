import { getTranslations } from "next-intl/server";
import { ButtonLink, DemoDataChip, SectionHeading } from "./ui";
import { reveal } from "@/lib/motion";

function ProductShot({ name, alt, width, height }: { name: string; alt: string; width: number; height: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-frame">
      {["dark", "light"].map((theme) => (
        // The images are captured from the real app with synthetic fixtures.
        // eslint-disable-next-line @next/next/no-img-element
        <img key={theme} className={`shot-${theme} h-auto w-full`} src={`/screenshots/${name}${theme === "light" ? "-light" : ""}.png`} alt={alt} width={width} height={height} loading="lazy" />
      ))}
    </div>
  );
}

export async function ReleaseOverview() {
  const t = await getTranslations("home.release");
  return (
    <div className="space-y-24">
      <section id="rail" {...reveal}>
        <SectionHeading title={t("rail.title")} lead={t("rail.lead")} />
        <div className="grid gap-6 md:grid-cols-2">
          {(["folded", "unfolded"] as const).map((state) => (
            <figure key={state} className="space-y-3">
              <ProductShot name={`rail-${state}`} alt={t(`rail.${state}Alt`)} width={1280} height={800} />
              <figcaption className="text-sm text-muted">{t(`rail.${state}`)}</figcaption>
            </figure>
          ))}
        </div>
      </section>
      <section id="agents" {...reveal}>
        <SectionHeading title={t("agents.title")} lead={t("agents.lead")} />
        <ProductShot name="desktop-home" alt={t("agents.alt")} width={2000} height={1520} />
        <p className="mt-4 text-sm text-muted">{t("agents.note")}</p>
      </section>
      <section id="terminal" {...reveal}>
        <SectionHeading title={t("terminal.title")} lead={t("terminal.lead")} />
        <ProductShot name="terminal-statusline" alt={t("terminal.alt")} width={2400} height={600} />
        <p className="mt-4 text-sm text-muted">{t("terminal.note")}</p>
      </section>
      <section id="web-app" className="grid items-center gap-10 md:grid-cols-[1fr_320px]" {...reveal}>
        <div>
          <SectionHeading title={t("phone.title")} lead={t("phone.lead")} />
          <p className="mb-6 text-sm leading-relaxed text-muted">{t("phone.note")}</p>
          <ButtonLink href="/app" tone="primary">{t("phone.cta")}</ButtonLink>
        </div>
        <div className="mx-auto w-full max-w-80">
          <ProductShot name="phone-1" alt={t("phone.alt")} width={1170} height={2532} />
        </div>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted">
        <p>{t("captureNote")}</p><DemoDataChip />
      </div>
    </div>
  );
}
