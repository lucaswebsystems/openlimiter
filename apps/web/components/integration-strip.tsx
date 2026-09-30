import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  AntigravityMark,
  ClaudeMark,
  CodexMark,
  GeminiMark,
  KimiMark,
  OpenCodeMark,
  OpenRouterMark,
  XaiMark,
  type ToolMarkProps,
} from "./tool-marks";
import { Chip, SectionHeading } from "./ui";
import { reveal } from "@/lib/motion";

/** Complete connector and output descriptions in static, centered rows. */
interface StripCard {
  name: string;
  /** The mono line at the foot of the card: a command, a key or a source. */
  tag: string;
  detail: string;
  state: "today" | "planned";
  Mark: (props: ToolMarkProps) => ReactNode;
}

/**
 * The card data, built from the catalog.
 *
 * `t` is the `integrations` namespace translator, passed in rather than called
 * at module scope: `useTranslations` only works inside the component. Provider
 * names (Claude, OpenRouter, Codex, Antigravity, OpenCode and the rest of the
 * catalogue) stay plain string literals rather than catalog entries, the same
 * way footer.tsx leaves GitHub as a literal: they are proper nouns, identical in
 * every language. "Manual entry" is not a brand and does go through the
 * catalog. The `openlimiter ingest` tag is the real command name, so it stays a
 * literal too rather than a translated sentence.
 */
function getConnectors(t: ReturnType<typeof useTranslations<"integrations">>): StripCard[] {
  return [
    {
      name: "Claude",
      Mark: ClaudeMark,
      state: "today",
      tag: t("connectors.claude.tag"),
      detail: t("connectors.claude.detail"),
    },
    {
      name: "OpenRouter",
      Mark: OpenRouterMark,
      state: "today",
      tag: t("connectors.openRouter.tag"),
      detail: t("connectors.openRouter.detail"),
    },
    {
      name: "Codex",
      Mark: CodexMark,
      state: "today",
      tag: t("connectors.codex.tag"),
      detail: t("connectors.codex.detail"),
    },
    {
      name: "Antigravity",
      Mark: AntigravityMark,
      state: "today",
      tag: t("connectors.antigravity.tag"),
      detail: t("connectors.antigravity.detail"),
    },
    {
      name: "OpenCode",
      Mark: OpenCodeMark,
      state: "today",
      tag: t("connectors.openCode.tag"),
      detail: t("connectors.openCode.detail"),
    },
    {
      name: "Grok Build",
      Mark: XaiMark,
      state: "today",
      tag: t("connectors.grok.tag"),
      detail: t("connectors.grok.detail"),
    },
    {
      name: "Gemini CLI",
      Mark: GeminiMark,
      state: "today",
      tag: t("connectors.gemini.tag"),
      detail: t("connectors.gemini.detail"),
    },
    {
      name: "Kimi",
      Mark: KimiMark,
      state: "today",
      tag: t("connectors.kimi.tag"),
      detail: t("connectors.kimi.detail"),
    },
  ];
}

/* The second row is surfaces rather than brands, so its glyphs are objects:
   a statusline, a hook, a shell, a file, a pipeline, a document. */

function StatuslineGlyph({ className = "h-5 w-5" }: ToolMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.75" y="6.75" width="18.5" height="10.5" rx="2.5" />
      <path d="M6 12h5M14 12h4" />
    </svg>
  );
}

function HookGlyph({ className = "h-5 w-5" }: ToolMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15.5 3.5v7.75a4.25 4.25 0 0 1-8.5 0" />
      <path d="M12.75 6.25h5.5" />
      <circle cx="7" cy="18.5" r="2.25" />
    </svg>
  );
}

function ShellGlyph({ className = "h-5 w-5" }: ToolMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="2.5" />
      <path d="m7 9.5 2.5 2.5L7 14.5M12.5 15h4.5" />
    </svg>
  );
}

function FileGlyph({ className = "h-5 w-5" }: ToolMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2.75H7.5a2 2 0 0 0-2 2v14.5a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7.25Z" />
      <path d="M13.75 2.9v4.35h4.35M9 13h6M9 16.5h4" />
    </svg>
  );
}

function PipelineGlyph({ className = "h-5 w-5" }: ToolMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="5.5" cy="6" r="2.25" />
      <circle cx="5.5" cy="18" r="2.25" />
      <circle cx="18.5" cy="12" r="2.25" />
      <path d="M7.75 6h4.5a4 4 0 0 1 4 4v.25M7.75 18h4.5a4 4 0 0 0 4-4v-.25" />
    </svg>
  );
}

function JsonGlyph({ className = "h-5 w-5" }: ToolMarkProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.25 3.75H7.5a2 2 0 0 0-2 2V10a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4.25a2 2 0 0 0 2 2h1.75" />
      <path d="M14.75 3.75h1.75a2 2 0 0 1 2 2V10a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4.25a2 2 0 0 1-2 2h-1.75" />
    </svg>
  );
}

/* The second row's tags are the exact command names (`openlimiter statusline`,
   `openlimiter hook`, `openlimiter snapshot`, `openlimiter ingest`,
   `openlimiter export`), so they stay literals for the same reason the CLI
   reference never translates a command. Only "one JSON document", a
   description rather than a command, comes from the catalog. */
function getSurfaces(t: ReturnType<typeof useTranslations<"integrations">>): StripCard[] {
  return [
    {
      name: t("surfaces.statusline.name"),
      Mark: StatuslineGlyph,
      state: "today",
      tag: "openlimiter statusline",
      detail: t("surfaces.statusline.detail"),
    },
    {
      name: t("surfaces.promptHook.name"),
      Mark: HookGlyph,
      state: "today",
      tag: "openlimiter hook",
      detail: t("surfaces.promptHook.detail"),
    },
    {
      name: t("surfaces.shell.name"),
      Mark: ShellGlyph,
      state: "today",
      tag: "openlimiter snapshot",
      detail: t("surfaces.shell.detail"),
    },
    {
      name: t("surfaces.fileWriter.name"),
      Mark: FileGlyph,
      state: "today",
      tag: "openlimiter ingest",
      detail: t("surfaces.fileWriter.detail"),
    },
    {
      name: t("surfaces.ci.name"),
      Mark: PipelineGlyph,
      state: "today",
      tag: "openlimiter export",
      detail: t("surfaces.ci.detail"),
    },
    {
      name: t("surfaces.ownFrontend.name"),
      Mark: JsonGlyph,
      state: "today",
      tag: t("surfaces.ownFrontend.tag"),
      detail: t("surfaces.ownFrontend.detail"),
    },
  ];
}

/**
 * One card, and two deliberate absences.
 *
 * THE MARK STANDS FREE. It used to sit in a tinted rounded square, which put a
 * second object around artwork that is already a logo: fourteen boxes reading
 * as a grid of buttons rather than a row of brands. The glyph is now drawn
 * bare, still in `currentColor`, still at 20 pixels, and the gap beside the
 * name does the spacing the box used to do.
 *
 * THERE IS NO `today` CHIP. Shipping is the default state of a card on this
 * page and a badge saying so is noise on every card that has one. `planned`
 * survives, because that one is a real exception a reader has to be told about,
 * and the support matrix under the provider grid states the rest.
 */
function Card({ card }: { card: StripCard }) {
  const t = useTranslations("integrations");
  const planned = card.state === "planned";
  return (
    <div className="lift elev-1 flex w-full flex-col items-center gap-[var(--ol-space-2)] rounded-xl border border-hairline bg-surface p-[var(--ol-space-4)] text-center hover:border-hairline-strong hover:bg-raised sm:w-[calc((100%-var(--ol-space-4))/2)] lg:w-[calc((100%-var(--ol-space-4)*2)/3)]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-center gap-[var(--ol-space-2)]">
          <div className="flex min-w-0 flex-col items-center justify-center gap-[var(--ol-space-3)]">
            <span
              aria-hidden="true"
              className={`flex-none ${planned ? "text-soft" : "text-heading"}`}
            >
              <card.Mark className="h-5 w-5" />
            </span>
            <p className="heading-face min-w-0 text-sm text-heading">{card.name}</p>
          </div>
          {planned && (
            <Chip tone="neutral" className="flex-none">
              {t("plannedChip")}
            </Chip>
          )}
        </div>
        <p className="mt-[var(--ol-space-3)] text-sm leading-relaxed text-muted">{card.detail}</p>
      </div>
    </div>
  );
}

// Wrapping rows keep every description visible and center incomplete final rows.
function Row({ cards }: { cards: readonly StripCard[] }) {
  return (
    <div className="flex flex-wrap items-stretch justify-center gap-[var(--ol-space-4)]">
      {cards.map((card) => <Card key={card.name} card={card} />)}
    </div>
  );
}

export function IntegrationStrip() {
  const t = useTranslations("integrations");
  const connectors = getConnectors(t);
  const surfaces = getSurfaces(t);
  return (
    <section>
      <SectionHeading title={t("title")} lead={t("lead")} />
      <div className="space-y-[var(--ol-space-5)]" {...reveal}>
        <Row cards={connectors} />
        <Row cards={surfaces} />
      </div>
    </section>
  );
}
