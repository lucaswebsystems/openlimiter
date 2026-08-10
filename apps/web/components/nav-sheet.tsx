"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The phone header's menu.
 *
 * A real sheet rather than a wrapped pile of desktop links. The header on a
 * phone is one row and only ever one row: mark on the left, the one filled
 * action and this button on the right. Everything else lives behind it.
 *
 * It behaves the way a modal has to behave, and none of that is decoration:
 *
 *   the trigger carries `aria-expanded`, so the state is announced;
 *   Escape closes it, and focus returns to the trigger it came from;
 *   Tab is trapped inside the sheet while it is open, so a keyboard cannot
 *   wander into the page behind a scrim it cannot see past;
 *   the body cannot scroll behind it, which is the difference between a sheet
 *   and a dropdown that happens to be large.
 *
 * The links themselves are handed in rather than declared here, so the header
 * has exactly one list and this component cannot drift from it.
 */

export interface SheetLink {
  label: string;
  href: string;
  external?: boolean;
}

/** Everything focusable a sheet can hold. Nothing here is a generic query. */
const FOCUSABLE = "a[href], button:not([disabled])";

export function NavSheet({
  links,
  extras,
  themeToggle,
}: {
  links: readonly SheetLink[];
  /** Rows that are not plain navigation: Sponsor, GitHub and the like. */
  extras: readonly SheetLink[];
  themeToggle: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const sheet = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    /* The page behind a sheet does not scroll. The scrollbar's own width is
       not compensated, because a phone has no scrollbar taking up space. */
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = sheet.current;
      if (panel === null) return;
      const nodes = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (first === undefined || last === undefined) return;

      /*
       * FOCUS THAT IS NOT IN THE SHEET IS PULLED BACK INTO IT FIRST.
       *
       * Wrapping only at the two ends assumes focus is already inside, and it
       * is not always: a press on the backdrop moves focus to the body, and
       * returning from the address bar restores it to wherever the browser
       * left it. From either of those the next Tab walked into the page behind
       * a modal it cannot see past. So the first question is whether focus is
       * inside this panel at all, and if it is not, the next Tab lands on the
       * first row rather than anywhere else.
       */
      const active = document.activeElement;
      if (!(active instanceof Node) || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }

      /* The cycle is closed by hand, because a sheet outside a dialog element
         is still in the document order of the page it covers. */
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    sheet.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, close]);

  const rowClass =
    "focus-ring rounded-lg px-3 py-2.5 text-base text-body transition-colors hover:bg-raised hover:text-heading";

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls="nav-sheet"
        aria-label={open ? "Close menu" : "Menu"}
        onClick={() => {
          setOpen((current) => !current);
        }}
        className="focus-ring inline-flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-lg border border-hairline-strong text-heading transition-colors hover:border-heading hover:bg-surface"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          {open ? <path d="m6 6 12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>

      {/* The overlay is PORTALED to the body, and that is a correctness rule,
          not a styling preference: the trigger lives inside the header's
          scope, which re declares every token in dark island values while the
          header floats over the footage. Rendered in place, the sheet would
          inherit that darkness in the light theme. As a child of body it
          resolves the page's real theme, always: a sheet is a reading panel,
          never part of the scenery behind it. It only renders after a press,
          so document is always there to receive it. */}
      {open && createPortal(
        <>
          {/* The scrim closes on a press, which is what a finger expects, and it
              is not focusable, because Escape is the keyboard's way out. */}
          <div
            aria-hidden="true"
            onClick={close}
            className="fixed inset-0 z-40 bg-canvas/70 backdrop-blur-sm"
          />
          <div
            id="nav-sheet"
            ref={sheet}
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="fixed inset-x-3 top-3 z-50 flex flex-col gap-1 rounded-2xl border border-hairline-strong bg-surface p-3 shadow-[0_24px_60px_-24px_rgb(0_0_0/0.6)]"
          >
            {links.map((link) => (
              <Link key={link.label} href={link.href} onClick={close} className={rowClass}>
                {link.label}
              </Link>
            ))}
            <span aria-hidden="true" className="my-1 h-px bg-hairline" />
            {extras.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={close}
                className={rowClass}
              >
                {link.label}
              </a>
            ))}
            <div className="mt-1 flex items-center justify-between gap-3 border-t border-hairline pt-3">
              <span className="px-3 text-sm text-muted">Theme</span>
              {themeToggle}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
