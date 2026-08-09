import type { ReactNode } from "react";
import { DemoDataChip } from "./ui";
import { hookCapture, statuslineCapture } from "@/lib/cli-capture";
import { humanise, parseDemoRows, worstPerProvider } from "@/lib/snapshot";

/**
 * Three phone sized panels.
 *
 * The web app is planned and not built, so there is no screenshot of it and
 * nothing here pretends otherwise. What these frames hold instead is the real
 * snapshot at phone width: every provider, meter and percentage below is parsed
 * out of the verbatim `openlimiter demo` capture in lib/cli-capture.ts, and the
 * two transcript panels are that file's statusline and hook captures printed
 * character for character. Nothing was drawn to fill the space.
 *
 * When the web app exists, these three become screenshots of it.
 */

function Phone({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="w-[240px] flex-none overflow-hidden rounded-phone border-4 border-frame bg-code shadow-2xl ring-1 ring-hairline">
      <div className="flex h-[496px] flex-col">
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <span className="text-xs font-medium text-heading">{label}</span>
          <DemoDataChip />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-4 pb-5">{children}</div>
      </div>
    </div>
  );
}

function MeterRow({
  provider,
  meter,
  percent,
}: {
  provider: string;
  meter: string;
  percent: number;
}) {
  return (
    <li className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-heading">{humanise(provider)}</span>
        <span className="font-mono text-2xs text-muted">{percent.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-track">
        <div
          className="h-full rounded-full bg-accent-solid"
          style={{ width: `${percent}%` }}
          role="img"
          aria-label={`${humanise(provider)}, ${humanise(meter)} meter, ${percent.toFixed(0)} percent of the window used`}
        />
      </div>
      <p className="font-mono text-2xs text-muted">{humanise(meter)}</p>
    </li>
  );
}

function TranscriptPanel({ text }: { text: string }) {
  return (
    <pre className="h-full overflow-hidden whitespace-pre-wrap break-words font-mono text-2xs leading-5 text-soft">
      {text}
    </pre>
  );
}

export function PhonePanels() {
  const rows = parseDemoRows();
  const worst = worstPerProvider(rows);

  return (
    <div className="flex items-center justify-center gap-6 overflow-hidden">
      <div className="hidden md:block">
        <Phone label="Statusline">
          <TranscriptPanel text={statuslineCapture.output} />
        </Phone>
      </div>
      <Phone label="Snapshot">
        <ul className="space-y-4">
          {worst.map((row) => (
            <MeterRow
              key={row.provider}
              provider={row.provider}
              meter={row.meter}
              percent={row.usagePercent}
            />
          ))}
        </ul>
      </Phone>
      <div className="hidden md:block">
        <Phone label="Agent context">
          <TranscriptPanel text={hookCapture.output} />
        </Phone>
      </div>
    </div>
  );
}
