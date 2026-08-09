import { CliTranscript } from "./cli-transcript";
import { CAPTURED_ON, demoCapture, hookCapture, statuslineCapture } from "@/lib/cli-capture";

/**
 * The one large product visual.
 *
 * The desktop application is being built by another hand and no screenshot of
 * it exists, so rather than mock one up this frame holds the thing that does
 * exist: three verbatim captures of the command line tool, printed exactly as
 * they came off standard output.
 *
 * Swapping in the real screenshot later is one line. Point SCREENSHOT at the
 * file and the frame renders the image instead, with no other change anywhere.
 */

interface Screenshot {
  src: string;
  width: number;
  height: number;
  alt: string;
}

/** The swap point. Null until a real capture of the desktop app exists. */
const SCREENSHOT: Screenshot | null = null;

function WindowChrome() {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-hairline px-4 py-3">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-hairline-strong" />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-hairline-strong" />
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-hairline-strong" />
        <span className="ml-2 font-mono text-2xs text-muted">openlimiter</span>
      </div>
      <span className="font-mono text-2xs text-muted">
        Real captured output. Synthetic fixtures.
      </span>
    </div>
  );
}

export function DeviceFrame() {
  return (
    <div className="relative px-6 pb-8 md:px-8 md:pb-16">
      <div className="mx-auto max-w-7xl">
        <div className="overflow-hidden rounded-xl bg-frame p-2 ring-1 ring-hairline sm:rounded-2xl sm:p-3">
          {SCREENSHOT !== null ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={SCREENSHOT.src}
              width={SCREENSHOT.width}
              height={SCREENSHOT.height}
              alt={SCREENSHOT.alt}
              className="block h-auto w-full rounded-lg sm:rounded-xl"
            />
          ) : (
            <div className="overflow-hidden rounded-lg bg-code sm:rounded-xl">
              <WindowChrome />
              <div className="grid gap-6 p-5 lg:grid-cols-2 lg:p-8">
                <div className="min-w-0 lg:col-span-2">
                  <CliTranscript capture={demoCapture} />
                </div>
                <CliTranscript capture={statuslineCapture} />
                <CliTranscript capture={hookCapture} />
              </div>
              <p className="border-t border-hairline px-5 py-3 font-mono text-2xs leading-relaxed text-muted">
                Captured on {CAPTURED_ON} from the synthetic demo fixtures. Every character above
                is verbatim standard output. No account, credential or real usage figure appears
                anywhere in it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
