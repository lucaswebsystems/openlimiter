import { useTranslations } from "next-intl";
import { ConnectionMatrix } from "./connection-matrix";
import { SiteLink } from "./site-link";
import { todayTools, toolTitle, type Tool } from "./tool-marks";
import { SectionHeading } from "./ui";
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
  return (
    <div
      title={toolTitle(tool, tToolTitle)}
      className="lift elev-1 flex items-center gap-3.5 rounded-xl border border-hairline bg-surface px-4 py-3.5 hover:border-hairline-strong hover:bg-raised"
      {...reveal}
    >
      <span aria-hidden="true" className="flex-none text-heading">
        <tool.Mark className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="heading-face block truncate text-sm text-heading">{tool.name}</span>
        <span className="mt-0.5 block text-xs text-muted">
          {t("tile.connector")}
        </span>
      </span>
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

      <p className="mt-6 w-full text-center text-sm leading-relaxed text-muted" {...reveal}>
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
