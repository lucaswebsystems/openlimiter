import { useTranslations } from "next-intl";
import { DemoDataChip, SectionHeading, SHELL } from "./ui";
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
 *
 * The accessible description of what is inside it does depend on it, though,
 * and that string lives in the message catalog (`deviceFrame.screenshot.alt`)
 * rather than on this object, so a locale change does not need a new capture.
 */

interface Screenshot {
  /** Basename under public/screenshots. The light file adds `-light`. */
  name: string;
  width: number;
  height: number;
}

const SCREENSHOT: Screenshot = {
  name: "desktop-app",
  width: 2560,
  height: 1600,
};

export function DeviceFrame() {
  const t = useTranslations("deviceFrame");
  const alt = t("screenshot.alt");
  const common = {
    width: SCREENSHOT.width,
    height: SCREENSHOT.height,
    className: "h-auto w-full rounded-lg sm:rounded-xl",
  };
  return (
    /* A real section, not a bare picture: air after the fold, a heading a
       reader can scan to, one lead sentence, then the frame. Lucas's call
       (2026-08-10) after the fold shipped with the image butted straight
       against the footage. */
    <section className={`${SHELL} relative pb-8 pt-16 md:pb-16 md:pt-24`}>
      <SectionHeading title={t("title")} lead={t("lead")} />
      <div {...reveal}>
        <div className="elev-2 overflow-hidden rounded-xl border border-hairline bg-frame p-2 sm:rounded-2xl sm:p-3">
          {/* The pair. Same file name, same dimensions, one of them hidden by
              the theme, so the largest visual on the page belongs to whichever
              theme the reader is actually in. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            {...common}
            alt={alt}
            src={`/screenshots/${SCREENSHOT.name}.png`}
            fetchPriority="high"
            className={`shot-dark ${common.className}`}
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            {...common}
            alt={alt}
            src={`/screenshots/${SCREENSHOT.name}-light.png`}
            loading="lazy"
            className={`shot-light ${common.className}`}
          />
        </div>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-xs leading-relaxed text-muted">{t("caption")}</p>
          <span className="flex-none">
            <DemoDataChip />
          </span>
        </div>
      </div>
    </section>
  );
}
