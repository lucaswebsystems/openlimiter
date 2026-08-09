import { CliTranscript } from "./cli-transcript";
import { ScrollReveal } from "./scroll-reveal";
import { DemoDataChip } from "./ui";
import { CAPTURED_ON, demoCapture, statuslineCapture } from "@/lib/cli-capture";

/**
 * The product visual.
 *
 * There is no mock in this panel. Both blocks are stdout from the command line
 * tool in this repository, run against the synthetic fixtures it ships with,
 * and pasted in unedited. See lib/cli-capture.ts for the commands and the
 * capture procedure. The chip stays visible at every breakpoint because the
 * numbers, while real output, come from fixtures rather than an account.
 */
export function HeroProductVisual() {
  return (
    <section className="px-4 pb-20 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal step={3}>
          <div className="overflow-hidden rounded-2xl border border-hairline bg-surface">
            <div className="flex items-center justify-between gap-4 border-b border-hairline bg-canvas px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span aria-hidden="true" className="hidden items-center gap-1.5 sm:flex">
                  <span className="h-2.5 w-2.5 rounded-full bg-hairline-strong" />
                  <span className="h-2.5 w-2.5 rounded-full bg-hairline-strong" />
                  <span className="h-2.5 w-2.5 rounded-full bg-hairline-strong" />
                </span>
                <span className="truncate font-mono text-2xs text-muted">
                  openlimiter, captured output
                </span>
              </div>
              <DemoDataChip />
            </div>

            <div className="space-y-6 p-4 sm:p-6">
              <CliTranscript capture={demoCapture} />
              <CliTranscript capture={statuslineCapture} />
            </div>

            <p className="border-t border-hairline bg-canvas px-4 py-3 font-mono text-2xs leading-relaxed text-muted">
              Captured on {CAPTURED_ON} from the command line tool in this repository, running
              against the synthetic fixtures it ships with. Nothing above is a reading from a real
              account.
            </p>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
