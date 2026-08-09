/**
 * Frequently asked questions.
 *
 * Native `details` elements, so the whole block ships without a line of
 * JavaScript, keeps the keyboard and screen reader behaviour the browser
 * already provides, and never renders an answer at zero opacity waiting to be
 * revealed. A closed answer is simply not painted.
 */

const items = [
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
      "Not yet. A desktop tray application is being built now and the web, iOS and Android builds are planned. None of them can be downloaded, none is in a store, and there is no waiting list. The download page lists every platform with its real state.",
  },
  {
    question: "Is it free?",
    answer:
      "Everything that runs locally is free and always will be, under Apache 2.0. The only thing that would ever cost money is a hosted service, namely encrypted synchronisation and push alerts, because servers cost money to run. It does not exist, there is no checkout, and no local feature has been withheld to create it.",
  },
];

export function Faq() {
  return (
    <div id="faq" className="space-y-6">
      <h2 className="text-3xl font-medium text-heading">FAQ</h2>
      <div className="space-y-6">
        {items.map((item) => (
          <details key={item.question} className="group">
            <summary className="focus-ring flex cursor-pointer list-none items-start gap-2 rounded text-sm font-medium text-heading">
              <span
                aria-hidden="true"
                className="mt-px w-3 flex-none font-mono text-muted group-open:hidden"
              >
                +
              </span>
              <span
                aria-hidden="true"
                className="mt-px hidden w-3 flex-none font-mono text-muted group-open:block"
              >
                &minus;
              </span>
              <span>{item.question}</span>
            </summary>
            <div className="mt-2 max-w-xl pl-5 text-sm leading-relaxed text-muted">
              {item.answer}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
