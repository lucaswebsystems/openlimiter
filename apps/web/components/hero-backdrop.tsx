"use client";

import { useEffect, useState } from "react";

/**
 * The moving backdrop behind the hero, and nothing else on the site.
 *
 * Footage: Pexels video 15439973, "A futuristic abstract pattern in motion".
 * The Pexels licence permits commercial use and asks for no attribution; the
 * credit is written here anyway so nobody has to guess where the file came
 * from or whether it was cleared. The files in public/backdrop are re encoded
 * from the 1280 wide rendition, not the original upload.
 *
 * This component decides one thing: whether the video is fetched at all.
 *
 *   - Under `prefers-reduced-motion: reduce`, never. A visitor who has asked
 *     for less motion gets the still poster and no request goes out.
 *   - Under 768 pixels, never. A phone gets the still poster, which is twenty
 *     kilobytes against the video's one and a half megabytes.
 *
 * Both are decided in JavaScript rather than in CSS because CSS can only hide
 * a video element, and a hidden video has already been fetched. The element
 * simply does not exist in either case.
 *
 * The poster is not rendered here at all: it is the background image of the
 * layer this returns, set in globals.css, so it paints with the stylesheet on
 * the first frame and stays put while the video streams in over it. There is
 * no state in which the hero has nothing behind it.
 *
 * Hydration: the first client render returns exactly what the server rendered,
 * the layer with no video inside it, and only the effect below can change that.
 * Nothing here is read during render.
 *
 * The whole component is switched off by HERO_BACKDROP_ENABLED in lib/site.ts,
 * which is checked by the hero rather than in here, so that when the flag is
 * false this file is never reached and the hero's markup is untouched.
 */

const WIDE_ENOUGH = "(min-width: 768px)";
const ASKED_FOR_CALM = "(prefers-reduced-motion: reduce)";

export function HeroBackdrop() {
  const [streaming, setStreaming] = useState(false);

  useEffect(() => {
    const wide = window.matchMedia(WIDE_ENOUGH);
    const calm = window.matchMedia(ASKED_FOR_CALM);

    const sync = () => setStreaming(wide.matches && !calm.matches);
    sync();

    wide.addEventListener("change", sync);
    calm.addEventListener("change", sync);
    return () => {
      wide.removeEventListener("change", sync);
      calm.removeEventListener("change", sync);
    };
  }, []);

  return (
    <div className="hero-backdrop" aria-hidden="true">
      {streaming && (
        <video
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          poster="/backdrop/hero-backdrop.jpg"
          disablePictureInPicture
          tabIndex={-1}
        >
          <source src="/backdrop/hero-backdrop.webm" type="video/webm" />
          <source src="/backdrop/hero-backdrop.mp4" type="video/mp4" />
        </video>
      )}
    </div>
  );
}
