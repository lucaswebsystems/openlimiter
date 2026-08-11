import { useTranslations } from "next-intl";
import { DemoDataChip } from "./ui";

/**
 * Three phones, drawn here, holding real captures of the running web app.
 *
 * THE FRAME IS OURS AND THE SCREEN IS EXACT
 * -----------------------------------------
 * The shell is CSS: a titanium coloured bezel with a continuous corner radius
 * and a pill over the top of the picture. No photograph of a device and no
 * vendor artwork is involved, and every measurement is a fraction of one screen
 * width variable so the proportions hold at any size.
 *
 * The screen is 440 by 956, which is the logical screen the captures are taken
 * at, so an image lands one to one inside it. That is the whole fix for the
 * squashed pictures this replaced: the old shell was a 210 by 440 window over a
 * 390 by 844 capture, so the app was shown at 54 percent and cropped, and the
 * result read as a cramped screenshot rather than as a phone.
 *
 * EACH VIEW SHIPS TWICE
 * ---------------------
 * A dark capture on a light page is a hole in the page, so every view has a
 * dark file and a light one at identical dimensions and the pair is swapped by
 * the theme in CSS. The hidden one is lazy, the visible one is not, and because
 * both are in the layout at the same size the swap cannot shift anything.
 *
 * The entries below are the whole contract with the files, except for the label
 * and the accessible description of each: those are prose and live in the
 * message catalog under `phonePanels.shots.<id>`, keyed by the same `id` this
 * file uses to pick the right basename. Retake the pictures with
 * scripts/capture-screenshots.mjs; nothing in this component knows or cares
 * what is inside a picture.
 */

interface PhoneShot {
  /** The catalog slug: `phonePanels.shots.<id>.label` and `.alt`. */
  id: "meters" | "agentContext" | "connections";
  /** Basename under public/screenshots. The light file adds `-light`. */
  name: string;
  width: number;
  height: number;
}

const shots: readonly PhoneShot[] = [
  { id: "meters", name: "phone-1", width: 1170, height: 2532 },
  { id: "agentContext", name: "phone-2", width: 1170, height: 2532 },
  { id: "connections", name: "phone-3", width: 1170, height: 2532 },
];

function Phone({
  shot,
  label,
  alt,
  className = "",
}: {
  shot: PhoneShot;
  label: string;
  alt: string;
  className?: string;
}) {
  const common = { width: shot.width, height: shot.height };
  return (
    <div className={`flex-none ${className}`}>
      {/* One variable drives the whole device, and it is sized so three of them
          fit the column they are in. Below the medium breakpoint only one phone
          is on screen and it is full width at base; at md (834px) three appear
          without overflow; at lg and up each phone is at least 300px wide. */}
      <div className="phone-body [--screen:min(320px,calc(100vw-3.5rem))] md:[--screen:216px] lg:[--screen:300px] xl:[--screen:350px]">
        <div style={{ aspectRatio: "390 / 844" }} className="phone-screen">
          <span
            aria-hidden="true"
            className="absolute left-1/2 top-[calc(var(--screen)*0.035)] z-10 h-[calc(var(--screen)*0.0168)] w-[calc(var(--screen)*0.24)] -translate-x-1/2 rounded-full bg-black shadow-[inset_0_0_0_1px_rgb(255_255_255_/_0.08)]"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            {...common}
            alt={alt}
            src={`/screenshots/${shot.name}.png`}
            className="shot-dark"
            loading="lazy"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            {...common}
            alt={alt}
            src={`/screenshots/${shot.name}-light.png`}
            className="shot-light"
            loading="lazy"
          />
        </div>
      </div>
      {/* Outside the frame, always. A watermark inside the screen would be part
          of the picture, and the picture is a capture, not a composite. */}
      <div className="mt-3 flex items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium text-heading">{label}</span>
        <DemoDataChip />
      </div>
    </div>
  );
}

export function PhonePanels() {
  const t = useTranslations("phonePanels");
  return (
    /* Below the medium breakpoint only the first shell is on the screen, and
       it is the meters view rather than whichever one happened to be in the
       middle: three phones do not fit on a phone, and the one that survives
       should be the one that shows what the product is for. */
    <div className="flex items-start justify-center gap-4 md:gap-3 lg:gap-6 xl:gap-7">
      <Phone shot={shots[0]} label={t("shots.meters.label")} alt={t("shots.meters.alt")} />
      <Phone
        shot={shots[1]}
        label={t("shots.agentContext.label")}
        alt={t("shots.agentContext.alt")}
        className="hidden md:block"
      />
      <Phone
        shot={shots[2]}
        label={t("shots.connections.label")}
        alt={t("shots.connections.alt")}
        className="hidden md:block"
      />
    </div>
  );
}
