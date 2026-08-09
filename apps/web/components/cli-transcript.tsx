import type { CliCapture } from "@/lib/cli-capture";

/**
 * Renders one real capture from lib/cli-capture.ts.
 *
 * The output is printed verbatim. The only styling applied to it is a colour
 * per whole line, chosen by matching the line's own prefix, so no character is
 * ever added, dropped, or rewritten on the way to the screen. The `$` in front
 * of the command is the shell prompt, not part of any captured output.
 */

function lineTone(line: string): string {
  /* The tags that fence the agent context block. */
  if (line.startsWith("<")) return "text-accent";
  /* The table header row, and the notice the hook prints about itself. */
  if (line.startsWith("PROVIDER ") || line.startsWith("notice=")) return "text-muted";
  return "text-heading";
}

export function CliTranscript({ capture }: { capture: CliCapture }) {
  const lines = capture.output.split("\n");

  return (
    <div>
      <p className="mb-3 font-mono text-2xs uppercase tracking-widest text-muted">
        {capture.caption}
      </p>
      <div className="overflow-x-auto rounded-xl border border-hairline bg-code px-4 py-3">
        <pre className="font-mono text-2xs leading-6">
          <code>
            <span aria-hidden="true" className="select-none text-accent">
              {"$ "}
            </span>
            <span className="text-body">{capture.command}</span>
            {"\n"}
            {lines.map((line, index) => (
              <span key={line} className={lineTone(line)}>
                {line}
                {index < lines.length - 1 ? "\n" : ""}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
