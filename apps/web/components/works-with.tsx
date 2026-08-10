import { useTranslations } from "next-intl";
import { ConnectionMatrix } from "./connection-matrix";
import { SiteLink } from "./site-link";
import { plannedTools, todayTools, toolTitle, type Tool } from "./tool-marks";
import { Chip, SectionHeading } from "./ui";
import { reveal, revealGroup, revealSm } from "@/lib/motion";

/**
 * The agent grid.
 *
 * Two groups, and the line between them is the point of the section. The first
 * group is the six connectors that ship in this release, under a label that
 * says so, and carrying no badge: shipping is the default here. The second is
 * twelve well known tools with no connector, each one carrying a `planned`
 * chip, so the grid can be as wide as the field without a single tile implying
 * support that does not exist.
 *
 * The note between them is what keeps the planned group honest rather than a
 * tease: every name on this page can be metered today by hand, through manual
 * entry or through the generic ingest command, and that is written out rather
 * than hinted at.
 *
 * Marks come from components/tool-marks.tsx, which reproduces real brand
 * artwork from Simple Icons in `currentColor`. Nothing here is a brand colour
 * and nothing is fetched.
 */

/**
 * One tile, with the mark drawn bare and no badge on the ordinary case.
 *
 * The tinted square around the logo is gone: a brand mark is already an object
 * and putting it in a second one turned this grid into eighteen buttons. The
 * `today` chip is gone for the same kind of reason: every tile in the first
 * group had one, so it said nothing, and the line under the name already says
 * `Connector`. `planned` stays, because that is the exception.
 */
function ToolTile({ tool }: { tool: Tool }) {
  const t = useTranslations("worksWith");
  /* The hover sentence is shared with every other surface that draws a tool
     mark, so it has its own namespace rather than living in this section's. */
  const tToolTitle = useTranslations("tools.title");
  const planned = tool.state === "planned";
  return (
    <div
      title={toolTitle(tool, tToolTitle)}
      className={`lift elev-1 flex items-center gap-3.5 rounded-xl border px-4 py-3.5 ${
        planned
          ? "border-hairline bg-canvas hover:border-hairline-strong hover:bg-surface"
          : "border-hairline bg-surface hover:border-hairline-strong hover:bg-raised"
      }`}
      {...reveal}
    >
      <span aria-hidden="true" className={`flex-none ${planned ? "text-soft" : "text-accent"}`}>
        <tool.Mark className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="heading-face block truncate text-sm text-heading">{tool.name}</span>
        <span className="mt-0.5 block text-xs text-muted">
          {planned ? t("tile.noConnector") : t("tile.connector")}
        </span>
      </span>
      {planned && (
        <Chip tone="neutral" className="flex-none">
          {t("tile.plannedChip")}
        </Chip>
      )}
    </div>
  );
}

/**
 * A planned tile, which is a smaller object than a shipping one.
 *
 * Twelve full width rows ran this section past 3700 pixels on a phone for a
 * list whose entire content is "we know about this and have not built it". So
 * below the small breakpoint they stack three across as a mark over a name, and
 * from there up they are the same row the shipping tiles use.
 *
 * The honesty rule survives the compaction untouched. Every tile still carries
 * both statements at every width: the line under the name reads `No connector
 * yet` and the chip reads `planned`. Only the arrangement changed. The hover
 * text carries the whole sentence including any former product name.
 */
function PlannedTile({ tool }: { tool: Tool }) {
  const t = useTranslations("worksWith");
  const tToolTitle = useTranslations("tools.title");
  return (
    <div
      title={toolTitle(tool, tToolTitle)}
      className="lift elev-1 flex flex-col items-center gap-1.5 rounded-xl border border-hairline bg-canvas px-2 py-3 text-center hover:border-hairline-strong hover:bg-surface sm:flex-row sm:gap-3.5 sm:px-4 sm:py-3.5 sm:text-left"
      {...reveal}
    >
      <span aria-hidden="true" className="flex-none text-soft">
        <tool.Mark className="h-5 w-5" />
      </span>
      <span className="min-w-0 sm:flex-1">
        <span className="heading-face block truncate text-xs text-heading sm:text-sm">
          {tool.name}
        </span>
        <span className="mt-0.5 block text-2xs leading-tight text-muted sm:text-xs">
          {t("tile.noConnector")}
        </span>
      </span>
      <Chip tone="neutral" className="flex-none">
        {t("tile.plannedChip")}
      </Chip>
    </div>
  );
}

function GroupLabel({ title, note }: { title: string; note: string }) {
  return (
    /* Below the small breakpoint the note takes a line of its own and the rule
       goes away, so a short label and a long one wrap the same way instead of
       one of them squeezing the rule down to a stub. */
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1" {...revealSm}>
      <h3 className="font-mono text-2xs uppercase tracking-widest text-heading">{title}</h3>
      <span aria-hidden="true" className="hidden h-px flex-1 bg-hairline sm:block" />
      <p className="w-full text-xs text-muted sm:w-auto">{note}</p>
    </div>
  );
}

export function WorksWith() {
  const t = useTranslations("worksWith");
  return (
    <section id="providers">
      <SectionHeading title={t("title")} lead={t("lead")} />

      <GroupLabel title={t("groups.today.label")} note={t("groups.today.note")} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" {...revealGroup}>
        {todayTools.map((tool) => (
          <ToolTile key={tool.name} tool={tool} />
        ))}
      </div>

      {/* Immediately under the six tiles, because the tiles are what invite the
          reading that six accounts get connected. */}
      <ConnectionMatrix />

      <div className="mt-10">
        <GroupLabel title={t("groups.planned.label")} note={t("groups.planned.note")} />
        <div
          className="grid grid-cols-3 gap-2.5 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4"
          {...revealGroup}
        >
          {plannedTools.map((tool) => (
            <PlannedTile key={tool.name} tool={tool} />
          ))}
        </div>
      </div>

      <div
        className="lift elev-1 mt-6 flex flex-col gap-4 rounded-xl border border-accent-subtle bg-accent-subtle px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
        {...reveal}
      >
        <p className="max-w-2xl text-sm leading-relaxed text-accent">{t("manualNote")}</p>
        <SiteLink
          href="/docs/ingestion"
          className="focus-ring inline-flex flex-none items-center gap-1.5 rounded text-sm font-medium text-accent hover:text-accent-hover"
        >
          {t("feedIn")}
          <span aria-hidden="true">&rarr;</span>
        </SiteLink>
      </div>

      <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted" {...reveal}>
        {t.rich("footnote", {
          code: (chunks) => <span className="font-mono text-2xs text-heading">{chunks}</span>,
          link: (chunks) => (
            <SiteLink
              href="/docs/providers"
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
