import sample from "@/lib/statusline-sample.json";
import { ProductCaption } from "./device-frame";

/* The dark theme band labels, fixed: the terminal card stays dark in both
   site themes, and the light theme labels fail contrast on it. */
const BAND_COLOR = {
  green: "#3fb950",
  yellow: "#e3b341",
  orange: "#ffa657",
  red: "#ff7b72",
} as const;

type Band = keyof typeof BAND_COLOR;
type StatuslineSpan = { text: string; band?: Band };

export function TerminalStatusline({ caption }: { caption: string }) {
  const cells = sample.cells as StatuslineSpan[][];
  return (
    <figure className="min-w-0 text-center">
      <div className="elev-1 mx-auto w-full overflow-hidden rounded-xl border border-hairline bg-frame p-[var(--ol-space-2)]" style={{ maxWidth: 1200 }}>
        <div className="@container rounded-lg bg-[var(--ol-fixed-dark-canvas)] px-5 py-7 text-left text-[var(--ol-fixed-dark-body)] sm:px-8 sm:py-10">
          <p className="font-sans text-sm text-[var(--ol-fixed-dark-muted)] sm:text-base">openlimiter statusline</p>
          {/* The type shrinks with the card, down to 12px, so the whole line keeps
              one row wherever it can (founder, 2026-10-01); below that the row
              wraps between cells, never inside one. 1.15cqi fits 141 characters. */}
          <div data-statusline-row className="mt-6 flex flex-wrap font-mono text-[length:clamp(0.75rem,1.15cqi,1rem)] leading-7">
            {cells.map((cell, cellIndex) => (
              <span data-statusline-cell className="whitespace-nowrap" key={cellIndex}>
                {cell.map((span, spanIndex) => (
                  <span key={spanIndex} style={span.band === undefined ? undefined : { color: BAND_COLOR[span.band] }}>
                    {span.text}
                  </span>
                ))}
                {cellIndex < cells.length - 1 && <span data-statusline-separator aria-hidden="true"> | </span>}
              </span>
            ))}
          </div>
        </div>
      </div>
      <ProductCaption caption={caption} />
    </figure>
  );
}
