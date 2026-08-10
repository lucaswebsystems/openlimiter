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
 * The entries below are the whole contract with the files. Retake them with
 * scripts/capture-screenshots.mjs; nothing in this component knows or cares
 * what is inside a picture.
 */

interface PhoneShot {
  /** Basename under public/screenshots. The light file adds `-light`. */
  name: string;
  width: number;
  height: number;
  label: string;
  alt: string;
}

const shots: readonly PhoneShot[] = [
  {
    name: "phone-1",
    width: 1170,
    height: 2532,
    label: "Meters",
    alt: "The web app on a phone, showing the overall verdict at the top and one card per provider below it, each with a meter bar, a percentage, a freshness state and a reset countdown.",
  },
  {
    name: "phone-2",
    width: 1170,
    height: 2532,
    label: "Agent context",
    alt: "The web app on a phone, showing the bounded block of budget state a coding agent receives, fenced in an untrusted data boundary.",
  },
  {
    name: "phone-3",
    width: 1170,
    height: 2532,
    label: "Connections",
    alt: "The web app on a phone, showing what each provider can be read from today and the box a quota document is pasted or dropped into.",
  },
];

function Phone({ shot, className = "" }: { shot: PhoneShot; className?: string }) {
  const common = { width: shot.width, height: shot.height };
  return (
    <div className={`flex-none ${className}`}>
      {/* One variable drives the whole device, and it is sized so three of them
          fit the column they are in. Below the medium breakpoint only one phone
          is on screen and it is full width at base; at md (834px) three appear
          without overflow; at lg and up each phone is at least 300px wide. */}
      <div className="phone-body [--screen:min(320px,calc(100vw-3.5rem))] md:[--screen:216px] lg:[--screen:300px] xl:[--screen:350px]">
        <div style={{ aspectRatio: "390 / 844" }} className="phone-screen">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            {...common}
            alt={shot.alt}
            src={`/screenshots/${shot.name}.png`}
            className="shot-dark"
            loading="lazy"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            {...common}
            alt={shot.alt}
            src={`/screenshots/${shot.name}-light.png`}
            className="shot-light"
            loading="lazy"
          />
          <span aria-hidden="true" className="phone-island" />
        </div>
      </div>
      {/* Outside the frame, always. A watermark inside the screen would be part
          of the picture, and the picture is a capture, not a composite. */}
      <div className="mt-3 flex items-center justify-between gap-2 px-1">
        <span className="text-xs font-medium text-heading">{shot.label}</span>
        <DemoDataChip />
      </div>
    </div>
  );
}

export function PhonePanels() {
  return (
    /* Below the medium breakpoint only the first shell is on the screen, and
       it is the meters view rather than whichever one happened to be in the
       middle: three phones do not fit on a phone, and the one that survives
       should be the one that shows what the product is for. */
    <div className="flex items-start justify-center gap-4 md:gap-3 lg:gap-6 xl:gap-7">
      <Phone shot={shots[0]} />
      <Phone shot={shots[1]} className="hidden md:block" />
      <Phone shot={shots[2]} className="hidden md:block" />
    </div>
  );
}
