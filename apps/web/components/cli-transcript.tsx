import { useTranslations } from "next-intl";
import { DemoDataChip } from "./ui";
import type { CliCapture } from "@/lib/cli-capture";

/**
 * Renders one real capture from lib/cli-capture.ts.
 *
 * The output is printed verbatim. The only styling applied to it is a colour
 * per whole line, chosen by matching the line's own prefix, so no character is
 * ever added, dropped, or rewritten on the way to the screen. The `$` in front
 * of the command is the shell prompt, not part of any captured output.
 *
 * The chip in the caption row is not decoration. Every capture on this site was
 * taken against synthetic fixtures, so every rendering of one says so.
 *
 * THE CAPTION IS THE ONE TRANSLATABLE PART OF A CAPTURE
 * -----------------------------------------------------
 * A capture's `command` and `output` are byte for byte what was typed and what
 * came back, which is data rather than copy and is identical in every language.
 * Its label is a phrase a person wrote, and that is copy, so the capture carries
 * an `id` and the words live at `cliTranscript.captions.<id>` in the catalogs.
 * The label is keyed by what the capture IS, never by what it currently says in
 * English, so a reworded label is one edit rather than a lookup that silently
 * stops matching.
 */

function lineTone(line: string): string {
  /* The tags that fence the agent context block. */
  if (line.startsWith("<")) return "text-accent";
  /* The table header row, and the notice the hook prints about itself. */
  if (line.startsWith("PROVIDER ") || line.startsWith("notice=")) return "text-muted";
  return "text-heading";
}

export function CliTranscript({ capture }: { capture: CliCapture }) {
  const t = useTranslations("cliTranscript");
  const lines = capture.output.split("\n");
  const caption = t(`captions.${capture.id}`);

  return (
    /* min-w-0 so a wide capture scrolls inside its own box rather than
       stretching whatever grid or flex row holds it. */
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-2xs uppercase tracking-widest text-muted">{caption}</p>
        <DemoDataChip />
      </div>
      <div className="overflow-x-auto rounded-lg border border-hairline bg-code px-4 py-3">
        <pre className="font-mono text-2xs leading-6">
          <code>
            <span aria-hidden="true" className="select-none text-accent">
              {"$ "}
            </span>
            <span className="text-soft">{capture.command}</span>
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
