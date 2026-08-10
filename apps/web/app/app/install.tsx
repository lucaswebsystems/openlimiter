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
 * own sheet, done. Once `appinstalled` follows, the button stays on screen and
 * switches to an Installed state for the rest of the session, because the tab
 * that ran the install is not itself the installed window, and a button that
 * simply vanished would read as broken rather than finished.
 *
 * iOS Safari fires nothing and exposes no API of any kind. The only honest
 * thing a button can do there is show the two taps Apple requires, so it opens
 * a small sheet with them drawn out. It is not a banner, it never appears on
 * its own, and it is only ever reached by pressing a control that says what it
 * does.
 *
 * A third case gets its own honest handling rather than being folded into
 * either of the other two: a browser that is neither confirmed Apple nor has
 * fired `beforeinstallprompt`. Guessing a platform from anything looser than
 * that is how a button ends up telling somebody the wrong two taps, so this
 * case opens the same sheet with both paths described, plainly, rather than
 * picking one.
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

/** Everything focusable the sheet can hold, for the Tab trap below. */
const FOCUSABLE = "a[href], button:not([disabled])";

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

/** The Installed state's glyph, replacing the download arrow once it is done. */
function CheckGlyph() {
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
      <path d="m5 12.5 4.5 4.5L19 7" />
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
  /* Set once by the appinstalled event and held for the rest of the session.
     The tab that captured the prompt is not itself the installed window, so
     hiding the button here would read as a control that vanished for no
     reason. Showing Installed instead confirms what just happened. */
  const [justInstalled, setJustInstalled] = useState(false);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [apple, setApple] = useState(false);
  const [sheet, setSheet] = useState(false);
  const trigger = useRef<HTMLSpanElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
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
      /* Fires in the tab that ran the install. That tab is not standalone, so
         the button stays on screen and only its state changes. */
      setJustInstalled(true);
      setPrompt(null);
      setSheet(false);
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
    if (!sheet) return undefined;

    /* The page behind the sheet does not scroll, the same rule every modal
       surface on this route follows. */
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    close.current?.focus();
    /* Captured now, not read again from the ref at cleanup time, because the
       ref itself can have moved on by then. */
    const triggerNode = trigger.current;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSheet(false);
        return;
      }
      if (event.key !== "Tab") return;
      const node = panel.current;
      if (node === null) return;
      const nodes = node.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (first === undefined || last === undefined) return;

      /*
       * Focus that is not in the sheet is pulled back into it first, the same
       * rule the site's own NavSheet uses: a press on the backdrop moves focus
       * to the body, and the next Tab from there must not reach the page
       * behind a scrim it cannot see past.
       */
      const active = document.activeElement;
      if (!(active instanceof Node) || !node.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      /* Returns focus to the button that opened the sheet. The shared Button
         component renders a plain <button>, so the first one found inside
         this wrapper is always it. */
      triggerNode?.querySelector<HTMLElement>("button")?.focus();
    };
  }, [sheet]);

  const install = useCallback(() => {
    if (prompt !== null) {
      void prompt.prompt().then(
        () => prompt.userChoice,
        () => null,
      );
      /* An event can only be replayed once, whatever the answer was. */
      setPrompt(null);
      return;
    }
    /* No captured prompt: either this is iOS Safari, which never fires one, or
       the platform could not be confirmed. Either way the sheet is the honest
       next step, never a click that silently does nothing. */
    setSheet(true);
  }, [prompt]);

  if (installed) return null;

  return (
    <>
      <span ref={trigger} className="contents">
        <Button
          tone="ghost"
          onClick={install}
          disabled={justInstalled}
          label={
            justInstalled
              ? "OpenLimiter is installed"
              : "Install OpenLimiter as an application"
          }
        >
          {justInstalled ? <CheckGlyph /> : <DownloadGlyph />}
          {justInstalled ? "Installed" : "Install app"}
        </Button>
      </span>

      {sheet && (
        <div
          className="ol-sheet-backdrop"
          role="presentation"
          onClick={() => {
            setSheet(false);
          }}
        >
          <div
            ref={panel}
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
              {apple
                ? "Safari has no install button of its own, so it takes two taps. Afterwards it opens like any other application, full screen and offline."
                : "This browser could not be confirmed, so both paths are shown below. Afterwards it opens like any other application, full screen and offline."}
            </p>

            {!apple && (
              <p className="mt-4 text-2xs uppercase tracking-widest text-muted">
                On iPhone or iPad
              </p>
            )}
            <ol className={apple ? "mt-4 space-y-2" : "mt-2 space-y-2"}>
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

            {!apple && (
              <>
                <p className="mt-4 text-2xs uppercase tracking-widest text-muted">
                  On Chrome, Edge or Android
                </p>
                <p className="mt-2 rounded-lg border border-hairline bg-raised px-3 py-2.5 text-sm leading-relaxed text-body">
                  Look for an install icon in the address bar, or open the browser menu
                  and choose Install OpenLimiter or Add to Home Screen.
                </p>
              </>
            )}

            <p className="mt-4 text-xs leading-relaxed text-muted">
              This installs the web app to your home screen. No native iOS or Android
              application is built.
            </p>

            <div className="mt-5 flex justify-end">
              <button
                ref={close}
                type="button"
                onClick={() => {
                  setSheet(false);
                }}
                className="ol-tap lift-sm focus-ring inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-transparent bg-solid px-4 py-2 text-sm font-medium text-on-solid hover:bg-solid-hover"
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
