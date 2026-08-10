"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./pieces";

/**
 * Installing this page as an application.
 *
 * There is no app store in this product's story, so the install has to happen
 * from the page itself, and the two platforms that matter offer completely
 * different amounts of help.
 *
 * Chrome, Edge and every Android browser built on them fire
 * `beforeinstallprompt` when the page qualifies. Holding that event and
 * replaying it from a button is the whole install: one press, the platform's
 * own sheet, done.
 *
 * iOS Safari fires nothing and exposes no API of any kind. The only honest
 * thing a button can do there is show the two taps Apple requires, so it opens
 * a small sheet with them drawn out. It is not a banner, it never appears on
 * its own, and it is only ever reached by pressing a control that says what it
 * does.
 *
 * Either way the control disappears the moment the page is running installed,
 * which the display mode media query answers without asking the platform
 * anything.
 */

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** True when this page is already running as an installed application. */
function runningInstalled(): boolean {
  if (typeof window === "undefined") return true;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.matchMedia("(display-mode: window-controls-overlay)").matches) return true;
  /* Older iOS reports it here and nowhere else. */
  const legacy = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return legacy === true;
}

/** True on an iPhone or an iPad, including an iPad that claims to be a Mac. */
function isAppleTouch(): boolean {
  if (typeof window === "undefined") return false;
  const agent = window.navigator.userAgent;
  if (/iphone|ipad|ipod/iu.test(agent)) return true;
  return /macintosh/iu.test(agent) && window.navigator.maxTouchPoints > 1;
}

function ShareGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 15V3.5" />
      <path d="m8.2 7.1 3.8-3.6 3.8 3.6" />
      <path d="M6.5 11H5.2A1.7 1.7 0 0 0 3.5 12.7v6.6A1.7 1.7 0 0 0 5.2 21h13.6a1.7 1.7 0 0 0 1.7-1.7v-6.6A1.7 1.7 0 0 0 18.8 11h-1.3" />
    </svg>
  );
}

function AddToHomeGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="M12 8.4v7.2M8.4 12h7.2" />
    </svg>
  );
}

function DownloadGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3.5v11" />
      <path d="m7.8 10.4 4.2 4.1 4.2-4.1" />
      <path d="M4.5 19.5h15" />
    </svg>
  );
}

function Step({
  index,
  glyph,
  children,
}: {
  index: number;
  glyph: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-hairline bg-raised px-3 py-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hairline bg-surface text-accent">
        {glyph}
      </span>
      <span className="min-w-0 text-sm leading-relaxed text-body">
        <span className="font-medium text-heading">{index}. </span>
        {children}
      </span>
    </li>
  );
}

export function InstallControl() {
  /* Installed until proven otherwise, so the control can never flash onto the
     screen of somebody who already has it and then vanish. */
  const [installed, setInstalled] = useState(true);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [apple, setApple] = useState(false);
  const [sheet, setSheet] = useState(false);
  const close = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setInstalled(runningInstalled());
    setApple(isAppleTouch());

    const capture = (event: Event) => {
      /* Holding the event is what makes a button possible at all: without
         this the platform shows its own bar, on its own schedule. */
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const done = () => {
      setInstalled(true);
      setPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", done);

    const media = window.matchMedia("(display-mode: standalone)");
    const watch = () => {
      setInstalled(runningInstalled());
    };
    media.addEventListener("change", watch);

    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", done);
      media.removeEventListener("change", watch);
    };
  }, []);

  useEffect(() => {
    if (!sheet) return;
    close.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheet(false);
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
    };
  }, [sheet]);

  const install = useCallback(() => {
    if (prompt === null) {
      setSheet(true);
      return;
    }
    void prompt.prompt().then(
      () => prompt.userChoice,
      () => null,
    );
    /* An event can only be replayed once, whatever the answer was. */
    setPrompt(null);
  }, [prompt]);

  if (installed) return null;
  if (prompt === null && !apple) return null;

  return (
    <>
      <Button tone="ghost" onClick={install} label="Install OpenLimiter as an application">
        <DownloadGlyph />
        Install app
      </Button>

      {sheet && (
        <div
          className="ol-sheet-backdrop"
          role="presentation"
          onClick={() => {
            setSheet(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-sheet-title"
            className="ol-sheet ol-sheen w-full max-w-md rounded-t-2xl border border-hairline bg-surface p-5 sm:rounded-2xl"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <h2 id="install-sheet-title" className="ol-brand-font text-base text-heading">
              Add OpenLimiter to your home screen
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              Safari has no install button of its own, so it takes two taps.
              Afterwards it opens like any other application, full screen and
              offline.
            </p>
            <ol className="mt-4 space-y-2">
              <Step index={1} glyph={<ShareGlyph />}>
                Tap <span className="font-medium text-heading">Share</span> in the
                browser toolbar.
              </Step>
              <Step index={2} glyph={<AddToHomeGlyph />}>
                Choose{" "}
                <span className="font-medium text-heading">Add to Home Screen</span>,
                then Add.
              </Step>
            </ol>
            <div className="mt-5 flex justify-end">
              <button
                ref={close}
                type="button"
                onClick={() => {
                  setSheet(false);
                }}
                className="ol-tap lift-sm focus-ring inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-transparent bg-solid px-4 py-2 text-sm font-medium text-on-solid hover:bg-solid-hover"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
