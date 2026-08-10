import type { ReactNode } from "react";
import {
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
import { Chip, CodeChip, IconChip, SectionHeading, VIEWPORT_BLEED } from "./ui";
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
 * on every card: a `today` chip and a real sentence about what the connector
 * reads, or a `planned` chip and one line saying the connector is not written
 * and manual entry is the path today. A card can never be read as support that
 * does not exist.
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

/** One short line, written once, for every card with no connector behind it. */
const PLANNED_LINE = "Planned connector. Meter it today through manual entry or ingest.";

const connectors: readonly StripCard[] = [
  {
    name: "Claude",
    Mark: ClaudeMark,
    state: "today",
    tag: "reads the native statusline payload",
    detail:
      "Parses the rate limit block Claude Code already hands to your statusline command. It asks nothing of Anthropic on its own.",
  },
  {
    name: "OpenRouter",
    Mark: OpenRouterMark,
    state: "today",
    tag: "reads a documented credits response",
    detail:
      "Parses the credits shape OpenRouter documents. The key belongs in your operating system credential store, never in a file.",
  },
  {
    name: "Codex",
    Mark: CodexMark,
    state: "today",
    tag: "reads an internal usage payload",
    detail:
      "Parses the usage shape the Codex tooling produces. The shape is internal, so it can change without notice, and it fails closed when it does.",
  },
  {
    name: "Antigravity",
    Mark: GoogleMark,
    state: "today",
    tag: "reads an internal quota payload",
    detail:
      "Parses the quota shape the Antigravity tooling produces. Internal too, marked as such, and never repaired or rewritten.",
  },
  {
    name: "OpenCode",
    Mark: OpenCodeMark,
    state: "today",
    tag: "reads a session you already opened",
    detail:
      "Describes the usage view behind an existing session. It carries the highest automation risk of the six and stops the moment that session expires.",
  },
  {
    name: "Perplexity",
    Mark: PerplexityMark,
    state: "planned",
    tag: "openlimiter ingest",
    detail: PLANNED_LINE,
  },
  {
    name: "Grok",
    Mark: XaiMark,
    state: "planned",
    tag: "openlimiter ingest",
    detail: PLANNED_LINE,
  },
  {
    name: "Gemini CLI",
    Mark: GeminiMark,
    state: "planned",
    tag: "openlimiter ingest",
    detail: PLANNED_LINE,
  },
  {
    name: "GitHub Copilot",
    Mark: CopilotMark,
    state: "planned",
    tag: "openlimiter ingest",
    detail: PLANNED_LINE,
  },
  {
    name: "Cursor",
    Mark: CursorMark,
    state: "planned",
    tag: "openlimiter ingest",
    detail: PLANNED_LINE,
  },
  {
    name: "Ollama",
    Mark: OllamaMark,
    state: "planned",
    tag: "openlimiter ingest",
    detail: PLANNED_LINE,
  },
  {
    name: "DeepSeek",
    Mark: DeepSeekMark,
    state: "planned",
    tag: "openlimiter ingest",
    detail: PLANNED_LINE,
  },
  {
    name: "Mistral",
    Mark: MistralMark,
    state: "planned",
    tag: "openlimiter ingest",
    detail: PLANNED_LINE,
  },
  {
    name: "Manual entry",
    Mark: ManualMark,
    state: "today",
    tag: "reads numbers you write yourself",
    detail:
      "Budgets you maintain by hand, for a self hosted model or any subscription without a connector. It never breaks and never guesses.",
  },
];

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

const surfaces: readonly StripCard[] = [
  {
    name: "Claude Code statusline",
    Mark: StatuslineGlyph,
    state: "today",
    tag: "openlimiter statusline",
    detail:
      "One line beside your prompt: the worst meter per provider with a reason code in front. It falls back to the cache and never blocks the tool that called it.",
  },
  {
    name: "Claude Code prompt hook",
    Mark: HookGlyph,
    state: "today",
    tag: "openlimiter hook",
    detail:
      "A bounded block on prompt submit, fenced in an explicit untrusted data boundary. When every provider is unknown it injects nothing at all.",
  },
  {
    name: "Any shell",
    Mark: ShellGlyph,
    state: "today",
    tag: "openlimiter snapshot",
    detail:
      "The whole snapshot as a table for you or as JSON for a script. No network call, no account, no daemon in the middle.",
  },
  {
    name: "Any tool that can write a file",
    Mark: FileGlyph,
    state: "today",
    tag: "openlimiter ingest",
    detail:
      "One generic command takes a payload for any connector, so a provider without an integration can still be fed from a script you control.",
  },
  {
    name: "Continuous integration",
    Mark: PipelineGlyph,
    state: "today",
    tag: "openlimiter export",
    detail:
      "Export the cache as JSON and assert on it in a pipeline. Every release is tested on Windows and Linux on every push.",
  },
  {
    name: "Your own front end",
    Mark: JsonGlyph,
    state: "today",
    tag: "one JSON document",
    detail:
      "The cache is a plain document on your disk with a versioned schema. Read it and build whatever view you want.",
  },
];

function Card({ card }: { card: StripCard }) {
  const planned = card.state === "planned";
  return (
    <div className="lift elev-1 flex h-[192px] w-[280px] flex-none flex-col justify-between gap-3 rounded-2xl border border-hairline bg-surface p-4 hover:border-hairline-strong hover:bg-raised sm:w-[330px]">
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <IconChip tone={planned ? "neutral" : "accent"}>
              <card.Mark className="h-5 w-5" />
            </IconChip>
            <p className="heading-face min-w-0 truncate text-sm text-heading">{card.name}</p>
          </div>
          <Chip tone={planned ? "neutral" : "accent"} dot={!planned} className="flex-none">
            {planned ? "planned" : "today"}
          </Chip>
        </div>
        <p className="mt-2.5 line-clamp-3 text-sm leading-relaxed text-muted">{card.detail}</p>
      </div>
      <CodeChip>{card.tag}</CodeChip>
    </div>
  );
}

function Row({ cards, reverse = false }: { cards: readonly StripCard[]; reverse?: boolean }) {
  return (
    <div className="strip">
      <div className={`strip-track ${reverse ? "strip-track-reverse" : ""}`}>
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
  return (
    <section>
      <SectionHeading
        title="What it reads, where it lands"
        lead="No testimonials, no avatar wall, no user count. Every card below either ships a connector in this release or says plainly that it does not have one yet."
      />
      <div className={`${VIEWPORT_BLEED} space-y-4`} {...reveal}>
        <Row cards={connectors} />
        <Row cards={surfaces} reverse />
      </div>
    </section>
  );
}
