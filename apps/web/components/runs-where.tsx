import { useTranslations } from "next-intl";
import { PhonePanels } from "./phone-panels";
import { SiteLink } from "./site-link";
import { SectionHeading } from "./ui";
import { reveal } from "@/lib/motion";

/**
 * Runs where you work.
 *
 * The three shells hold real captures of the web app at phone size, which is
 * why the note underneath calls them screenshots rather than a mockup. The
 * numbers inside them come from the project's synthetic fixtures, so every
 * shell carries a demo data chip. The iOS and Android applications remain
 * planned and unbuilt, and nothing here suggests otherwise.
 *
 * There is no transcript on this section any more. The statusline and the hook
 * are shown once each, in the two sections that exist to explain them, rather
 * than a third time here.
 */
export function RunsWhere() {
  const t = useTranslations("runsWhere");
  return (
    <section id="runs-where">
      <SectionHeading title={t("title")} lead={t("lead")} />
      <div {...reveal}>
        <PhonePanels />
      </div>
      <p className="mx-auto mt-8 max-w-[70ch] text-center text-sm leading-relaxed text-muted" {...reveal}>
        {t.rich("screenshotsNote", {
          webApp: (chunks) => (
            <SiteLink
              href="/app"
              className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
            >
              {chunks}
            </SiteLink>
          ),
        })}
      </p>
    </section>
  );
}
