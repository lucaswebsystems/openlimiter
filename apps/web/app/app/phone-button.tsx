"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "./pieces";
import { encodeQr, type QrMatrix } from "@/lib/qr";
import { SITE_URL } from "@/lib/site";
import { SiteLink } from "@/components/site-link";

/**
 * The hub header's "Open on your phone" button, and the small panel under it.
 *
 * The panel carries one sentence and one QR code, and nothing else. Only the
 * desktop application can mint a pairing code: the server contract gives code
 * creation to the desktop, and a code minted anywhere else would be one the
 * desktop never learns about and so can never approve. A hub in a browser
 * therefore has no live code to draw, so the panel says where a code comes
 * from, points at the desktop download, and encodes the pair page itself with
 * no code on it. Scanned on the phone, that page explains the same step where
 * the reader already is.
 *
 * The QR is generated in the browser by lib/qr.ts, the port of the CLI's own
 * encoder, so no third party package ever touches a pairing address.
 */

/** The address the panel encodes: the pair page, deliberately codeless. */
const PAIR_PAGE_URL = `${SITE_URL}/app/pair`;

/** Modules of light margin around the symbol. Four is the published minimum. */
const QUIET_ZONE = 4;

function PhoneGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M10.5 5h3" />
      <path d="M12 18.5h.01" />
    </svg>
  );
}

/**
 * The matrix as SVG: one path of dark modules on a light field.
 *
 * A scanner needs dark modules on light, whichever theme the page around it is
 * in, so the field is a literal white and the modules a literal black rather
 * than a theme token. This is generated artwork, like the icons under
 * public/, not a themed surface. The whole symbol is one path of unit
 * squares, which keeps the markup a single element at any version.
 */
function QrSvg({ matrix, label }: { matrix: QrMatrix; label: string }) {
  const parts: string[] = [];
  matrix.modules.forEach((line, row) => {
    line.forEach((dark, column) => {
      if (dark) parts.push(`M${column + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
    });
  });
  const span = matrix.size + QUIET_ZONE * 2;
  return (
    <svg
      viewBox={`0 0 ${span} ${span}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className="block h-auto w-full"
    >
      <rect x="0" y="0" width={span} height={span} fill="#ffffff" />
      <path d={parts.join("")} fill="#000000" />
    </svg>
  );
}

/** Elements a focus trap is willing to land on or cycle through. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function PhoneButton() {
  const t = useTranslations("hub");
  const [open, setOpen] = useState(false);
  const [matrix, setMatrix] = useState<QrMatrix | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  /* The symbol is computed the first time the panel opens, not on every
     render and not before anyone has asked for it. */
  useEffect(() => {
    if (!open || matrix !== null) return;
    try {
      setMatrix(encodeQr(PAIR_PAGE_URL));
    } catch {
      setMatrix(null);
    }
  }, [open, matrix]);

  /*
   * Focus moved in on open, trapped while open, and returned on close.
   *
   * The panel is a real modal: it covers the one thing behind it worth
   * reading (the button that opened it) and Escape or an outside click both
   * count as dismissal. `role="dialog"` alone tells a screen reader nothing
   * about where focus should go, so this effect does the three things that
   * make it behave like one: move focus onto the panel the moment it mounts,
   * keep Tab and Shift+Tab cycling only through what is inside it, and hand
   * focus back to the trigger the instant it closes, so a keyboard user is
   * never left with focus on an element that just vanished.
   */
  useEffect(() => {
    if (!open) return;
    const node = panel.current;
    const trigger = wrap.current;
    node?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || node === null) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    const onDown = (event: MouseEvent) => {
      if (trigger !== null && !trigger.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      /* The trigger button is the one this wrapper renders outside the panel,
         so it is found by element type rather than by a ref the shared Button
         component does not forward. The wrapper node itself is snapshotted
         above, not read again here, since a ref's `.current` can already
         point elsewhere by the time this cleanup runs. */
      trigger?.querySelector<HTMLButtonElement>(":scope > button")?.focus();
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <Button
        tone="ghost"
        onClick={() => {
          setOpen((current) => !current);
        }}
        title={t("phone.button")}
      >
        <PhoneGlyph />
        {t("phone.button")}
      </Button>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label={t("phone.button")}
          tabIndex={-1}
          className="elev-2 absolute right-0 top-full z-40 mt-2 w-64 rounded-xl border border-hairline bg-surface p-4 focus:outline-none"
        >
          <p className="text-sm leading-relaxed text-muted">{t("phone.line")}</p>
          <div className="mt-3 overflow-hidden rounded-lg border border-hairline">
            {matrix === null ? (
              <div aria-hidden="true" className="block w-full" style={{ aspectRatio: "1 / 1" }} />
            ) : (
              <QrSvg matrix={matrix} label={t("phone.qrAlt")} />
            )}
          </div>
          <p className="mt-3 text-sm leading-relaxed">
            <SiteLink
              href="/download"
              className="focus-ring rounded-md text-accent underline underline-offset-2"
            >
              {t("phone.download")}
            </SiteLink>
          </p>
        </div>
      )}
    </div>
  );
}
