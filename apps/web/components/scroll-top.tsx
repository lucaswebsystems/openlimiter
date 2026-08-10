"use client";

import { useEffect, useState } from "react";

/**
 * Back to top.
 *
 * It appears after one viewport of scrolling and not a pixel sooner, because a
 * control offering to undo a scroll that has not happened is furniture. It sits
 * in the bottom right corner, clear of everything the pages put in a corner,
 * and it is the only fixed element on the site.
 *
 * MOTION IS A PREFERENCE, NOT A DEFAULT
 * -------------------------------------
 * A visitor who has asked their system for less motion gets an instant jump.
 * The preference is read at the moment of the press rather than cached at
 * mount, so a system setting changed while the page is open is respected
 * without a reload.
 *
 * The listener is passive and does nothing but compare two numbers, so it costs
 * a scroll frame nothing measurable.
 */
export function ScrollTop() {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setShown(window.scrollY > window.innerHeight);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <button
      type="button"
      aria-label="Back to top"
      title="Back to top"
      /* Hidden from everything, not merely invisible, until it is offered. A
         button a keyboard can reach and an eye cannot find is worse than no
         button at all. */
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      onClick={() => {
        const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: still ? "auto" : "smooth" });
      }}
      className={`focus-ring fixed bottom-5 right-5 z-30 inline-flex h-11 w-11 items-center justify-center rounded-full border border-hairline bg-surface text-soft shadow-[0_8px_20px_-10px_rgb(0_0_0/0.6)] transition-[opacity,transform,color,border-color] duration-200 hover:border-hairline-strong hover:text-accent ${
        shown ? "cursor-pointer opacity-100" : "pointer-events-none translate-y-2 opacity-0"
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-[18px] w-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M12 19V5M6 11l6-6 6 6" />
      </svg>
    </button>
  );
}
