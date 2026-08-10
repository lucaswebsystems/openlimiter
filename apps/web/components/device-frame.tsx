import { DemoDataChip, SHELL } from "./ui";
import { reveal } from "@/lib/motion";

/**
 * The one large product visual.
 *
 * This used to hold three command line transcripts, because no capture of the
 * desktop application existed. One does now, so the frame holds the product
 * itself: a real window shot of the packaged application, taken against the
 * project's synthetic demo fixtures, which is what the chip and the caption
 * underneath say in the open.
 *
 * SCREENSHOT below is the whole contract with the file. The image is served
 * from public/ at its natural pixel size, and only its width and height are
 * written here, so the capture can be retaken at any time and the frame follows
 * it. Nothing in this component depends on what is inside the picture.
 */

interface Screenshot {
  src: string;
  width: number;
  height: number;
  alt: string;
}

const SCREENSHOT: Screenshot = {
  src: "/screenshots/desktop-app.png",
  width: 2560,
  height: 1600,
  alt: "The OpenLimiter desktop application, showing one card per provider with a meter, a percentage, a freshness state and a reset countdown, over synthetic demo data.",
};

export function DeviceFrame() {
  return (
    <div className={`${SHELL} relative pb-8 md:pb-16`}>
      <div {...reveal}>
        <div className="elev-2 overflow-hidden rounded-xl border border-hairline bg-frame p-2 sm:rounded-2xl sm:p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={SCREENSHOT.src}
            width={SCREENSHOT.width}
            height={SCREENSHOT.height}
            alt={SCREENSHOT.alt}
            fetchPriority="high"
            className="block h-auto w-full rounded-lg sm:rounded-xl"
          />
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-xs leading-relaxed text-muted">
            The packaged desktop application, captured on a real machine against the project&apos;s
            synthetic demo fixtures. No account, credential or real usage figure appears in it.
          </p>
          <span className="flex-none">
            <DemoDataChip />
          </span>
        </div>
      </div>
    </div>
  );
}
