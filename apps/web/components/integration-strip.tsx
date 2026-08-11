import { useTranslations } from "next-intl";
import type { CSSProperties, ReactNode } from "react";
import {
  AntigravityMark,
  ClaudeMark,
  CodexMark,
  CopilotMark,
  CursorMark,
  DeepSeekMark,
  GeminiMark,
  GoogleMark,
  ManualMark,
  MistralMark,
  OllamaMark,
  OpenCodeMark,
  OpenRouterMark,
  PerplexityMark,
  XaiMark,
  type ToolMarkProps,
} from "./tool-marks";
import { Chip, CodeChip, SectionHeading, VIEWPORT_BLEED } from "./ui";
import { reveal } from "@/lib/motion";

/**
 * The strip that sits where a reference site of this shape puts a wall of user
 * quotes and avatars.
 *
 * We have no users to quote and will not invent any, so the same slot carries
 * the thing that is actually true about the project: what it reads, and where
 * it puts the result. Nobody is quoted, no avatar appears, and no count of
 * anything is claimed.
 *
 * The honesty rule this section runs on. The first row is wide enough to read
 * as the field rather than as five names, so it carries well known tools that
 * have no connector as well as the ones that do, and the difference is stated
 * on every card that needs it: a `planned` chip and one line saying the
 * connector is not written and manual entry is the path today. A card with no
 * chip ships one, which is the ordinary case and does not need a badge, and its
 * own sentence still says exactly what it reads. A card can never be read as
 * support that does not exist.
 *
 * Both rows run the full width of the viewport, not the shell: on any screen
 * wider than the content column, stopping at the column edge left dead gutters
 * either side and the strip read as clipped. The mask at each end now fades at
 * the true screen edge, so the two partial cards read as a strip that
 * continues past the glass rather than as content cut by a container.
 */

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
  const plannedLine = t("plannedLine");
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
      name: "Perplexity",
      Mark: PerplexityMark,
      state: "planned",
      tag: "openlimiter ingest",
      detail: plannedLine,
    },
    {
      name: "Grok",
      Mark: XaiMark,
      state: "planned",
      tag: "openlimiter ingest",
      detail: plannedLine,
    },
    {
      name: "Gemini CLI",
      Mark: GeminiMark,
      state: "planned",
      tag: "openlimiter ingest",
      detail: plannedLine,
    },
    {
      name: "GitHub Copilot",
      Mark: CopilotMark,
      state: "planned",
      tag: "openlimiter ingest",
      detail: plannedLine,
    },
    {
      name: "Cursor",
      Mark: CursorMark,
      state: "planned",
      tag: "openlimiter ingest",
      detail: plannedLine,
    },
    {
      name: "Ollama",
      Mark: OllamaMark,
      state: "planned",
      tag: "openlimiter ingest",
      detail: plannedLine,
    },
    {
      name: "DeepSeek",
      Mark: DeepSeekMark,
      state: "planned",
      tag: "openlimiter ingest",
      detail: plannedLine,
    },
    {
      name: "Mistral",
      Mark: MistralMark,
      state: "planned",
      tag: "openlimiter ingest",
      detail: plannedLine,
    },
    {
      name: t("connectors.manualEntry.name"),
      Mark: ManualMark,
      state: "today",
      tag: t("connectors.manualEntry.tag"),
      detail: t("connectors.manualEntry.detail"),
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
    <div className="lift elev-1 flex h-[136px] w-[280px] flex-none flex-col gap-2 rounded-2xl border border-hairline bg-surface p-4 hover:border-hairline-strong hover:bg-raised sm:w-[330px]">
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className={`flex-none ${planned ? "text-soft" : "text-heading"}`}
            >
              <card.Mark className="h-5 w-5" />
            </span>
            <p className="heading-face min-w-0 truncate text-sm text-heading">{card.name}</p>
          </div>
          {planned && (
            <Chip tone="neutral" className="flex-none">
              {t("plannedChip")}
            </Chip>
          )}
        </div>
        <p className="mt-2.5 line-clamp-3 text-sm leading-relaxed text-muted">{card.detail}</p>
      </div>
    </div>
  );
}

/*
  Two velocities: the top row is slowed to roughly half speed (15.334s per card)
  so its wide span reads calm, while the bottom row stays at its 7.667s pace.

  Every card is a fixed 280px, 330 from `sm`, with a 1rem gap between them, so a
  track is exactly as long as the number of cards on it. Pinning seconds PER
  CARD keeps the speed constant when cards are added or removed.
*/
const SECONDS_PER_CARD = 7.667;
const FIRST_ROW_SECONDS_PER_CARD = 15.334;

function Row({
  cards,
  reverse = false,
  secondsPerCard = SECONDS_PER_CARD,
}: {
  cards: readonly StripCard[];
  reverse?: boolean;
  secondsPerCard?: number;
}) {
  return (
    <div className="strip">
      <div
        className={`strip-track ${reverse ? "strip-track-reverse" : ""}`}
        style={
          { "--strip-duration": `${(cards.length * secondsPerCard).toFixed(2)}s` } as CSSProperties
        }
      >
        {cards.map((card) => (
          <Card key={card.name} card={card} />
        ))}
        {/* The seamless second copy. It is duplicate content, so it is hidden
            from assistive technology, and under reduced motion, where the track
            wraps instead of sliding, it is removed from the layout entirely by
            the rule in globals.css rather than doubling the block. */}
        <div className="strip-clone contents" aria-hidden="true">
          {cards.map((card) => (
            <Card key={`${card.name}-clone`} card={card} />
          ))}
        </div>
      </div>
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
      <div className={`${VIEWPORT_BLEED} space-y-4`} {...reveal}>
        <Row cards={connectors} secondsPerCard={FIRST_ROW_SECONDS_PER_CARD} />
        <Row cards={surfaces} reverse />
      </div>
    </section>
  );
}
