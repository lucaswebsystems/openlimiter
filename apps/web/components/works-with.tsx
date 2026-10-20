import { useTranslations } from "next-intl";
import registry from "../lib/provider-specs.generated.json";
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
 * Which reviewed registry entry each tile is.
 *
 * The line under a tool's name says, in the reader's words, whether it works
 * today or may break when the tool updates, and that comes from the registry
 * rather than from this file: a tool whose reader is one its maker does not
 * document can stop when that tool changes. The verification internals, the
 * parser, reader and auth stages, live in the provider docs, not here.
 */
const SPEC_IDS: Readonly<Record<string, string>> = {
  "Claude Code": "anthropic/claude-code",
  "OpenAI Codex": "openai/codex",
  "Google Antigravity": "google/antigravity",
  "Gemini CLI": "google/gemini-cli",
  "Grok Build": "xai/grok-cli",
  Kimi: "moonshot/kimi-code",
  OpenCode: "opencode/opencode",
  OpenRouter: "openrouter/api",
};

function mayBreak(tool: Tool): boolean {
  const entry = registry.providers.find((row) => row.id === SPEC_IDS[tool.name]);
  return entry === undefined || entry.readers.includes("experimental");
}

/**
 * One tile, with the mark drawn bare and no badge on the ordinary case.
 *
 * The tinted square around the logo is gone: a brand mark is already an object
 * and putting it in a second one turned this grid into eighteen buttons. The
 * line under the name says whether the tool works today or may break when it
 * updates.
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
        <span className="heading-face block truncate text-sm text-heading">
          {tool.name}
        </span>
        <span className="mt-0.5 block text-xs text-muted">
          {t(mayBreak(tool) ? "tile.mayBreak" : "tile.works")}
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
    <div
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1"
      {...revealSm}
    >
      <p className="eyebrow font-mono text-2xs uppercase tracking-widest text-heading">
        {title}
      </p>
      <span
        aria-hidden="true"
        className="hidden h-px flex-1 bg-hairline sm:block"
      />
      <p className="w-full text-xs text-muted sm:w-auto">{note}</p>
    </div>
  );
}

export function WorksWith() {
  const t = useTranslations("worksWith");
  return (
    <section id="providers">
      <SectionHeading title={t("title")} lead={t("lead")} />

      <GroupLabel
        title={t("groups.today.label")}
        note={t("groups.today.note")}
      />
      <div
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
        {...revealGroup}
      >
        {todayTools.map((tool) => (
          <ToolTile key={tool.name} tool={tool} />
        ))}
      </div>

      <p
        className="mt-6 w-full text-center text-sm leading-relaxed text-muted"
        {...reveal}
      >
        {t.rich("footnote", {
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

      <p
        className="mt-4 w-full text-center text-xs leading-relaxed text-muted/80"
        {...reveal}
      >
        {t("compatibilityNote")}
      </p>
    </section>
  );
}
