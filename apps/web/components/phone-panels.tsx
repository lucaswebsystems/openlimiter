import { DemoDataChip } from "./ui";

/**
 * Three phone sized panels, and what is inside them.
 *
 * These were a hand built mock of the snapshot at phone width, because no
 * capture of the web app on a phone existed. Three do now, so the shells hold
 * real screenshots of the running web app at phone size, taken against the
 * project's synthetic demo fixtures. Every shell still carries a demo data
 * chip, because the numbers in the picture are fixtures rather than an account.
 *
 * The three entries below are the whole contract with the files. Each one is
 * served from public/ at its natural pixel size, and only that size is written
 * here, so the captures can be retaken at any time and these shells follow
 * them. Nothing in this component depends on what is inside a picture.
 */

interface PhoneShot {
  src: string;
  width: number;
  height: number;
  label: string;
  alt: string;
}

const shots: readonly PhoneShot[] = [
  {
    src: "/screenshots/phone-1.png",
    width: 780,
    height: 1688,
    label: "Meters",
    alt: "The web app on a phone, showing the overall verdict at the top and one card per provider below it, each with a meter bar, a percentage, a freshness state and a reset countdown.",
  },
  {
    src: "/screenshots/phone-2.png",
    width: 780,
    height: 1688,
    label: "Agent context",
    alt: "The web app on a phone, showing the bounded block of budget state a coding agent receives, fenced in an untrusted data boundary.",
  },
  {
    src: "/screenshots/phone-3.png",
    width: 780,
    height: 1688,
    label: "Ingest",
    alt: "The web app on a phone, showing the box a quota document is pasted or dropped into, and where such a document comes from.",
  },
];

function Phone({ shot, className = "" }: { shot: PhoneShot; className?: string }) {
  return (
    <div className={`flex-none ${className}`}>
      <div className="elev-2 w-[210px] overflow-hidden rounded-phone border-4 border-frame bg-code sm:w-[240px]">
        <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
          <span className="text-xs font-medium text-heading">{shot.label}</span>
          <DemoDataChip />
        </div>
        <div className="h-[440px] overflow-hidden px-3 pb-3 sm:h-[496px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shot.src}
            width={shot.width}
            height={shot.height}
            alt={shot.alt}
            loading="lazy"
            className="block h-full w-full rounded-xl border border-hairline object-cover object-top"
          />
        </div>
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
    <div className="flex items-center justify-center gap-4 sm:gap-6">
      <Phone shot={shots[0]} />
      <Phone shot={shots[1]} className="hidden md:block" />
      <Phone shot={shots[2]} className="hidden md:block" />
    </div>
  );
}
