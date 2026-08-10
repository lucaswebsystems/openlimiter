import { reveal, revealGroup } from "@/lib/motion";

/**
 * Frequently asked questions.
 *
 * Native `details` elements, so the whole block ships without a line of
 * JavaScript, keeps the keyboard and screen reader behaviour the browser
 * already provides, and never renders an answer at zero opacity waiting to be
 * revealed. A closed answer is simply not painted.
 *
 * The list below is exported because the home page also emits it as FAQPage
 * structured data. Both readings come from this one array, so the answer a
 * person opens and the answer a machine parses are the same string and cannot
 * drift apart. Answers are plain text for the same reason: structured data
 * carries no markup, so an answer that needed a link would have to be written
 * twice.
 */

export interface FaqItem {
  question: string;
  answer: string;
}

export const faqItems: readonly FaqItem[] = [
  {
    question: "What actually leaves my machine?",
    answer:
      "Nothing. There is no telemetry, no analytics, and no OpenLimiter server to receive anything. This release performs no provider egress at all: every connector is a parser over data that something else already wrote to your disk or piped to standard input.",
  },
  {
    question: "Is it safe to point at my tools?",
    answer:
      "OpenLimiter opens what your installed tools already store, read only, and never rewrites, repairs or migrates them. Every parser keeps bounded numbers and timestamps and discards provider text before anything reaches your agent.",
  },
  {
    question: "Can the prompt hook break my session?",
    answer:
      "No. The hook reads the local cache, makes no network request, injects nothing when every provider is unknown, and exits 0 whatever happens. The statusline behaves the same way: if input is absent or malformed it falls back to the cache and reports unknown.",
  },
  {
    question: "Which providers work today?",
    answer:
      "Six connectors ship: Claude through the native statusline payload, OpenRouter through its documented shape, Codex and Antigravity through internal shapes that may break, OpenCode through an existing session that may break, and manual entry. Every one is marked UNVERIFIED until an explicit verifier exists.",
  },
  {
    question: "Do I need an API key?",
    answer:
      "Not to start. The Claude path reads a payload Claude Code already hands your statusline, and the manual path needs nothing at all. OpenRouter is the one connector that expects a key of your own, and that key belongs in your operating system credential store.",
  },
  {
    question: "Does it route my requests for me?",
    answer:
      "No, and it is not going to. OpenLimiter provides advice. It does not route requests automatically, does not bypass a limit, and does not touch how your agent authenticates. The decision stays with you.",
  },
  {
    question: "What happens when a connector breaks?",
    answer:
      "Unofficial shapes change without notice. When one does, parsing fails closed: that provider returns to unknown, the other providers are unaffected, and nothing invents a number to fill the gap. Unknown never becomes zero.",
  },
  {
    question: "Is there a desktop or phone app?",
    answer:
      "The desktop tray application is built and packaged for Windows, macOS and Linux, and every build is attached to the release on GitHub. None of them are code signed yet, so Windows SmartScreen and macOS Gatekeeper warn the first time you open one, and the download page says how to get past that. On a phone, the web app opens in the browser and installs to a home screen. Native iOS and Android applications are not built, nothing is in a store, and there is no waiting list. The download page lists every platform with its real state.",
  },
  {
    question: "Is it free?",
    answer:
      "Everything that runs locally is free and always will be, under Apache 2.0: every connector, the agent context block, themes, the whole command line tool, and all three ingestion paths, with no usage limit and no account. Desktop notifications are not built yet and will be free too.",
  },
  {
    question: "What is OpenLimiter Pro?",
    answer:
      "A planned paid tier at $5 a month, founding price, for the things that can only run on servers: encrypted synchronisation across your devices, push notifications to your phone, a smart limiter that routes between your models from live budget state, email alerts and a weekly digest, delivery rules, hosted history and burn trends, priority connector requests, and a team tier later. It is not built. There is no checkout and no waiting list, and nothing that runs locally today ever moves behind it.",
  },
];

/**
 * The chevron. One glyph that rotates a quarter turn on open rather than two
 * glyphs swapping places, which is what a reader expects from an accordion and
 * what the pointer response elsewhere on the site already implies.
 */
function Chevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 flex-none text-muted transition-transform duration-200 group-open:rotate-90 group-hover:text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

export function Faq() {
  return (
    <div id="faq" className="space-y-6">
      <h2 className="text-3xl font-medium text-heading" {...reveal}>
        FAQ
      </h2>
      {/* Two columns from the large breakpoint. Nine items in one column ran
          past a screen height on their own; in two they read as a block, and
          each item is a self contained card so an open answer pushes only its
          own column. */}
      <div className="grid gap-3 lg:grid-cols-2 lg:gap-x-4" {...revealGroup}>
        {faqItems.map((item) => (
          <details
            key={item.question}
            className="lift-sm elev-1 group h-fit rounded-xl border border-hairline bg-surface transition-colors hover:border-hairline-strong open:border-hairline-strong open:bg-raised"
            {...reveal}
          >
            <summary className="focus-ring-inset flex cursor-pointer list-none items-start gap-3 rounded-xl px-4 py-3.5 text-sm font-medium text-heading transition-colors duration-200 group-hover:text-accent">
              <Chevron />
              <span className="heading-face min-w-0">{item.question}</span>
            </summary>
            <div className="border-t border-hairline px-4 py-3.5 pl-11 text-sm leading-relaxed text-muted">
              {item.answer}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
