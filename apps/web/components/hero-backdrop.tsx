"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * The fold's media: poster always, footage for whoever can receive it.
 *
 * Footage: Pexels video 15439973, "A futuristic abstract pattern in motion".
 * The Pexels licence permits commercial use and asks for no attribution; the
 * credit is written here anyway so nobody has to guess where the file came
 * from or whether it was cleared. The files in public/backdrop are re encoded
 * from the 1280 wide rendition, not the original upload.
 *
 * The poster is not rendered here at all: it is the background image of the
 * media layer, set in globals.css, so it paints with the stylesheet on the
 * first frame and stays put whether or not any video ever loads. The layer is
 * absolute inside a fold of fixed height, so there is no path by which this
 * media moves layout: displacement zero by construction, not by luck.
 *
 * This component decides whether the video exists at all, and only after
 * hydration, which keeps the file off the critical path of the first paint:
 *
 *   - under `prefers-reduced-motion: reduce`, never;
 *   - under 768 pixels, never (a phone gets the twenty kilobyte still, not
 *     the megabyte file);
 *   - when the visitor asked to save data, never.
 *
 * All three are decided in JavaScript rather than CSS because CSS can only
 * hide a video element, and a hidden video has already been fetched.
 *
 * Once frames exist the video fades in over the poster (`data-ready` in
 * globals.css), pauses whenever the fold leaves the screen, and resumes when
 * it returns, through an IntersectionObserver rather than any scroll work. A
 * pause the visitor asked for outlives scrolling: coming back to the top must
 * not undo what they chose. The pause control satisfies WCAG 2.2.2, moving
 * content that starts by itself, lasts over five seconds and runs in
 * parallel needs a way to stop, and it is a solid fill like every other
 * control in the fold, never a ghost over footage.
 *
 * `playLabel` and `pauseLabel` arrive as props rather than from a translator
 * called in here: this is a Client Component, and `useTranslations` needs the
 * request scoped context a Server Component render has and this one does not.
 * `hero.tsx`, the Server Component that renders this one, reads the two
 * strings from the `hero` catalog and hands them down already resolved.
 */

const WIDE_ENOUGH = "(min-width: 768px)";
const ASKED_FOR_CALM = "(prefers-reduced-motion: reduce)";

/**
 * The fold's copy arrives as children and renders BETWEEN the media layer and
 * the pause control, so the DOM order is the reading order: background first,
 * then the headline, the downloads and the links, and the pause pill last.
 * A keyboard reaches everything the fold says before it reaches the pill,
 * which is what WCAG's focus order asks of a control that merely stops the
 * scenery. Paint order does not depend on any of this: the copy carries z-10
 * and the pill z-20.
 */
export function HeroFoldMedia({
  children,
  playLabel,
  pauseLabel,
}: {
  children: ReactNode;
  /** Accessible name and visible text when the pill offers to resume. */
  playLabel: string;
  /** Accessible name and visible text when the pill offers to stop. */
  pauseLabel: string;
}) {
  const [streaming, setStreaming] = useState(false);
  const [ready, setReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const wide = window.matchMedia(WIDE_ENOUGH);
    const calm = window.matchMedia(ASKED_FOR_CALM);
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection;

    const sync = () =>
      setStreaming(wide.matches && !calm.matches && connection?.saveData !== true);
    sync();

    wide.addEventListener("change", sync);
    calm.addEventListener("change", sync);
    return () => {
      wide.removeEventListener("change", sync);
      calm.removeEventListener("change", sync);
    };
  }, []);

  /* Off the screen, the footage stops. A chosen pause wins over scrolling. */
  useEffect(() => {
    const box = boxRef.current;
    if (!streaming || box === null) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const video = videoRef.current;
        if (video === null || entry === undefined || paused) return;
        if (entry.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0 },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, [streaming, paused]);

  const toggle = () => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused) {
      void video.play().catch(() => {});
      setPaused(false);
    } else {
      video.pause();
      setPaused(true);
    }
  };

  return (
    <>
      <div ref={boxRef} aria-hidden="true" className="hero-fold-media">
        {streaming && (
          <video
            ref={videoRef}
            autoPlay
            loop
            muted
            playsInline
            preload="none"
            poster="/backdrop/hero-backdrop.jpg"
            disablePictureInPicture
            tabIndex={-1}
            data-ready={ready ? "true" : "false"}
            onPlaying={() => setReady(true)}
          >
            <source src="/backdrop/hero-backdrop.webm" type="video/webm" />
            <source src="/backdrop/hero-backdrop.mp4" type="video/mp4" />
          </video>
        )}
      </div>

      {children}

      {streaming && (
        <button
          type="button"
          onClick={toggle}
          aria-pressed={paused}
          className="focus-ring absolute bottom-5 right-5 z-20 inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-heading transition-colors hover:bg-raised"
        >
          {paused ? (
            <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current" aria-hidden="true">
              <path d="M7 4.6v14.8a.6.6 0 0 0 .92.5l11.5-7.4a.6.6 0 0 0 0-1L7.92 4.1a.6.6 0 0 0-.92.5Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" className="h-3 w-3 fill-current" aria-hidden="true">
              <path d="M6.5 4h3.4v16H6.5zM14.1 4h3.4v16h-3.4z" />
            </svg>
          )}
          {paused ? playLabel : pauseLabel}
        </button>
      )}
    </>
  );
}
