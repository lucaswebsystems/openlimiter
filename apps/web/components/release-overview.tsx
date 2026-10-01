import { getTranslations } from "next-intl/server";
import { ButtonLink, SectionHeading } from "./ui";
import { ProductFigure } from "./device-frame";
import { PhonePanels } from "./phone-panels";
import { TerminalStatusline } from "./terminal-statusline";
import { CURRENT_VERSION } from "@/lib/site";
import { reveal } from "@/lib/motion";

export async function ReleaseOverview() {
  const t = await getTranslations("home.release");
  return (
    <div className="space-y-[calc(var(--ol-space-7)*2)] text-center">
      <section id="edge-tab" {...reveal}>
        <SectionHeading title={t("rail.title")} lead={t("rail.lead", { version: CURRENT_VERSION })} />
        <div className="grid gap-6 md:grid-cols-2">
          {([["folded", "edge-tab"], ["unfolded", "edge-panel"]] as const).map(([state, shot]) => (
            <ProductFigure key={state} name={shot} alt={t(`rail.${state}Alt`)} caption={t(`rail.${state}`)} />
          ))}
        </div>
      </section>
      <section id="agents" {...reveal}>
        <SectionHeading title={t("agents.title")} lead={t("agents.lead")} />
        <ProductFigure name="desktop-home" alt={t("agents.alt")} caption={t("agents.note")} />
      </section>
      <section id="terminal" {...reveal}>
        <SectionHeading title={t("terminal.title")} lead={t("terminal.lead")} />
        <TerminalStatusline caption={t("terminal.note")} />
      </section>
      <section id="web-app" className="rounded-2xl border border-hairline bg-surface p-[var(--ol-space-5)] md:p-[var(--ol-space-7)]" {...reveal}>
        <SectionHeading title={t("phone.title")} lead={t("phone.lead")} />
        <PhonePanels />
        <p className="mx-auto mt-[var(--ol-space-5)] max-w-2xl text-sm leading-relaxed text-body">{t("phone.note")}</p>
        <div className="mt-[var(--ol-space-5)]">
          <ButtonLink href="/app" tone="primary">{t("phone.cta")}</ButtonLink>
        </div>
      </section>
      <p className="mx-auto max-w-2xl text-sm leading-relaxed text-muted">{t("captureNote")}</p>
    </div>
  );
}
