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

export default function PhoneButton() {
  const t = useTranslations("hub");
  const [open, setOpen] = useState(false);
  const [matrix, setMatrix] = useState<QrMatrix | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onDown = (event: MouseEvent) => {
      if (wrap.current !== null && !wrap.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
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
          role="dialog"
          aria-label={t("phone.button")}
          className="elev-2 absolute right-0 top-full z-40 mt-2 w-64 rounded-xl border border-hairline bg-surface p-4"
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
