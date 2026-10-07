"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function Sheet({
  open,
  title,
  closeLabel,
  onClose,
  returnFocus,
  children,
}: {
  open: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const nodes = panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    nodes?.[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab" || panel.current === null) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (!(active instanceof Node) || !panel.current.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
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
      returnFocus?.focus();
    };
  }, [open, returnFocus]);

  if (!open) return null;
  return createPortal(
    <div className="ol-sheet-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ol-sheet ol-sheen w-full max-w-md rounded-t-2xl border border-hairline bg-surface p-5 sm:rounded-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ol-sheet-head">
          <h2 id={titleId} className="ol-brand-font text-base text-heading">{title}</h2>
          <button type="button" className="ol-sheet-close focus-ring" onClick={onClose} aria-label={closeLabel}>×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
