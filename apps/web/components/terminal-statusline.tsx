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

/* The CLI draws a meter as `[████░░░░░░]`. Web monospace fonts often lack the
   shade glyph, and the fallback font pokes out of the line (2026-10-01), so the
   meter is drawn as two blocks, one character cell wide per glyph. */
const METER = /^\[(█*)(░*)\]$/u;

export function TerminalMeter({ filled, empty, color }: { filled: number; empty: number; color: string }) {
  return (
    <>
      [
      <span data-statusline-meter aria-hidden="true" className="inline-flex h-[1em] align-[-0.15em]">
        <span style={{ width: `${filled}ch`, background: color }} />
        <span style={{ width: `${empty}ch`, background: color, opacity: 0.25 }} />
      </span>
      <span className="sr-only">{`${"█".repeat(filled)}${"░".repeat(empty)}`}</span>]
    </>
  );
}

function Span({ span }: { span: StatuslineSpan }) {
  const color = span.band === undefined ? undefined : BAND_COLOR[span.band];
  const meter = METER.exec(span.text);
  if (meter !== null && color !== undefined) {
    return <TerminalMeter filled={[...meter[1]].length} empty={[...meter[2]].length} color={color} />;
  }
  return <span style={color === undefined ? undefined : { color }}>{span.text}</span>;
}

export function TerminalStatusline({ caption }: { caption: string }) {
  const cells = sample.cells as StatuslineSpan[][];
  return (
    <figure className="min-w-0 text-center">
      <div className="elev-1 mx-auto w-full overflow-hidden rounded-xl border border-hairline bg-frame p-[var(--ol-space-2)]" style={{ maxWidth: 1200 }}>
        <div className="rounded-lg bg-[var(--ol-fixed-dark-canvas)] px-5 py-7 text-left text-[var(--ol-fixed-dark-body)] sm:px-8 sm:py-10">
          <p className="font-sans text-sm text-[var(--ol-fixed-dark-muted)] sm:text-base">openlimiter statusline</p>
          {/* The sample is one terminal row. Narrow screens scroll this code
              sample horizontally, so separators never become line leaders. */}
          <div data-statusline-row className="mt-6 overflow-x-auto whitespace-nowrap font-mono text-sm leading-8 sm:text-base">
            {cells.map((cell, cellIndex) => (
              <span data-statusline-cell className="whitespace-pre" key={cellIndex}>
                {cellIndex > 0 && <span data-statusline-separator aria-hidden="true"> | </span>}
                {cell.map((span, spanIndex) => (
                  <Span span={span} key={spanIndex} />
                ))}
              </span>
            ))}
          </div>
        </div>
      </div>
      <ProductCaption caption={caption} />
    </figure>
  );
}
