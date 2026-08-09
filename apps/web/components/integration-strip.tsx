import { FULL_BLEED, SectionHeading } from "./ui";
import { reveal } from "@/lib/motion";

/**
 * The strip that sits where a reference site of this shape puts a wall of user
 * quotes and avatars.
 *
 * We have no users to quote and will not invent any, so the same slot carries
 * the thing that is actually true about the project: what it reads, and where
 * it puts the result. Every card names a real connector or a real surface that
 * ships in this release. Nobody is quoted, no avatar appears, and no count of
 * anything is claimed.
 *
 * Both rows run the full width of the shell rather than the width of the text
 * beside them: a sliding row reads as a row only when it is wider than a card
 * is, and the earlier version cut its cards off inside a column narrower than
 * the sections around it. The mask at each end is what makes the two partial
 * cards read as a strip that continues rather than as content clipped by a
 * container.
 */

interface StripCard {
  name: string;
  detail: string;
  tag: string;
}

const connectors: readonly StripCard[] = [
  {
    name: "Claude",
    tag: "reads the native statusline payload",
    detail:
      "Parses the rate limit block Claude Code already hands to your statusline command. It asks nothing of Anthropic on its own.",
  },
  {
    name: "OpenRouter",
    tag: "reads a documented credits response",
    detail:
      "Parses the credits shape OpenRouter documents. The key belongs in your operating system credential store, never in a file.",
  },
  {
    name: "Codex",
    tag: "reads an internal usage payload",
    detail:
      "Parses the usage shape the Codex tooling produces. The shape is internal, so it can change without notice, and it fails closed when it does.",
  },
  {
    name: "Antigravity",
    tag: "reads an internal quota payload",
    detail:
      "Parses the quota shape the Antigravity tooling produces. Internal too, marked as such, and never repaired or rewritten.",
  },
  {
    name: "OpenCode",
    tag: "reads a session you already opened",
    detail:
      "Describes the usage view behind an existing session. It carries the highest automation risk of the six and stops the moment that session expires.",
  },
  {
    name: "Manual entry",
    tag: "reads numbers you write yourself",
    detail:
      "Budgets you maintain by hand, for a self hosted model or any subscription without a connector. It never breaks and never guesses.",
  },
];

const surfaces: readonly StripCard[] = [
  {
    name: "Claude Code statusline",
    tag: "openlimiter statusline",
    detail:
      "One line beside your prompt: the worst meter per provider with a reason code in front. It falls back to the cache and never blocks the tool that called it.",
  },
  {
    name: "Claude Code prompt hook",
    tag: "openlimiter hook",
    detail:
      "A bounded block on prompt submit, fenced in an explicit untrusted data boundary. When every provider is unknown it injects nothing at all.",
  },
  {
    name: "Any shell",
    tag: "openlimiter snapshot",
    detail:
      "The whole snapshot as a table for you or as JSON for a script. No network call, no account, no daemon in the middle.",
  },
  {
    name: "Any tool that can write a file",
    tag: "openlimiter ingest",
    detail:
      "One generic command takes a payload for any connector, so a provider without an integration can still be fed from a script you control.",
  },
  {
    name: "Continuous integration",
    tag: "openlimiter export",
    detail:
      "Export the cache as JSON and assert on it in a pipeline. Every release is tested on Windows and Linux on every push.",
  },
  {
    name: "Your own front end",
    tag: "one JSON document",
    detail:
      "The cache is a plain document on your disk with a versioned schema. Read it and build whatever view you want.",
  },
];

function Card({ card }: { card: StripCard }) {
  return (
    <div className="lift flex h-[150px] w-[340px] flex-none flex-col justify-between rounded-2xl border border-hairline bg-surface p-4 hover:border-hairline-strong hover:bg-raised">
      <div>
        <p className="text-sm font-medium text-heading">{card.name}</p>
        <p className="mt-2 text-sm leading-relaxed text-muted">{card.detail}</p>
      </div>
      <p className="font-mono text-2xs text-muted">{card.tag}</p>
    </div>
  );
}

function Row({ cards, reverse = false }: { cards: readonly StripCard[]; reverse?: boolean }) {
  return (
    <div className="strip">
      <div className={`strip-track ${reverse ? "strip-track-reverse" : ""}`}>
        {[...cards, ...cards].map((card, index) => (
          <Card key={`${card.name}-${index}`} card={card} />
        ))}
      </div>
    </div>
  );
}

export function IntegrationStrip() {
  return (
    <section>
      <SectionHeading
        title="What it reads, where it lands"
        lead="No testimonials, no avatar wall, no user count. Every card below is a connector or a surface that ships in this release."
      />
      <div className={`${FULL_BLEED} space-y-4`} {...reveal}>
        <Row cards={connectors} />
        <Row cards={surfaces} reverse />
      </div>
    </section>
  );
}
