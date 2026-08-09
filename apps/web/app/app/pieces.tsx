"use client";

import { useEffect, useState, type ReactNode } from "react";
import { floorFixed, type MeterView, type ProviderView } from "./engine";

/**
 * The small parts the dashboard is built from.
 *
 * They share the site's tokens rather than any colour of their own, so this
 * page reads as the same product as the pages around it, in both themes.
 */

const PROVIDER_NAMES: Record<string, string> = {
  CLAUDE: "Claude",
  OPENROUTER: "OpenRouter",
  CODEX: "Codex",
  ANTIGRAVITY: "Antigravity",
  OPENCODE: "OpenCode",
  MANUAL: "Manual",
};

export function providerName(code: string): string {
  return PROVIDER_NAMES[code] ?? code;
}

const stateTone = {
  fresh: "border-hairline bg-raised text-heading",
  stale: "border-hairline bg-surface text-body",
  unknown: "border-dashed border-hairline-strong bg-canvas text-muted",
} as const;

export function StateChip({ state }: { state: MeterView["state"] }) {
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-2xs ${stateTone[state]}`}
    >
      {state}
    </span>
  );
}

/**
 * A relative time that never renders on the server.
 *
 * The exact instant is always in the title attribute, because "in 3 days" is
 * useful and "at 14:02 on Sunday" is what somebody actually plans around.
 */
export function Instant({ value, prefix }: { value: string | null; prefix: string }) {
  const [rendered, setRendered] = useState<string | null>(null);
  useEffect(() => {
    if (value === null) {
      setRendered(null);
      return;
    }
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      setRendered(null);
      return;
    }
    setRendered(new Date(parsed).toLocaleString());
  }, [value]);
  if (value === null) return <span className="text-muted">no reset window</span>;
  return (
    <span title={value}>
      {prefix} {rendered ?? value}
    </span>
  );
}

function barTone(value: number): string {
  if (value >= 100) return "bg-heading";
  if (value >= 80) return "bg-accent-solid";
  return "bg-accent-solid/70";
}

export function UsageBar({ value, muted }: { value: number; muted: boolean }) {
  const width = Math.min(100, Math.max(0, value));
  return (
    <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-track">
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${muted ? "bg-hairline-strong" : barTone(value)}`}
        style={{ width: `${String(width)}%` }}
      />
    </div>
  );
}

export function ProviderCard({ view }: { view: ProviderView }) {
  const worst = view.worst;
  const rest = view.meters.filter((meter) => meter !== worst);
  return (
    <div className="flex h-full flex-col rounded-xl border border-hairline bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-sans text-sm font-medium text-heading">
            {providerName(view.provider)}
          </h3>
          <p className="mt-0.5 font-mono text-2xs uppercase tracking-widest text-muted">
            {view.provider}
          </p>
        </div>
        {worst === null ? (
          <StateChip state="unknown" />
        ) : (
          <StateChip state={worst.state} />
        )}
      </div>

      {worst === null ? (
        <>
          <p className="mt-5 font-sans text-2xl font-medium tracking-tight text-muted">
            unknown
          </p>
          <UsageBar value={0} muted />
          <p className="mt-3 font-sans text-xs leading-relaxed text-muted">
            Nothing readable was supplied for this provider, so nothing is claimed.
            It is not zero and it is not exhausted.
          </p>
        </>
      ) : (
        <>
          <p className="mt-5 font-sans text-3xl font-medium tracking-tight text-heading tabular-nums">
            {floorFixed(worst.value, 1)}
            <span className="ml-1 font-sans text-base font-normal text-body">%</span>
          </p>
          <UsageBar value={worst.value} muted={worst.state === "stale"} />
          <dl className="mt-4 space-y-1.5 font-mono text-2xs text-muted">
            <div className="flex justify-between gap-3">
              <dt>meter</dt>
              <dd className="text-body">{worst.meter}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>reset</dt>
              <dd className="text-right text-body">
                <Instant value={worst.resetAt} prefix="" />
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>precision</dt>
              <dd className="text-body">{worst.precision}</dd>
            </div>
          </dl>
          {rest.length > 0 && (
            <div className="mt-4 border-t border-hairline pt-3">
              {rest.map((meter) => (
                <div
                  key={meter.meter}
                  className="flex items-baseline justify-between gap-3 font-mono text-2xs text-muted"
                >
                  <span>{meter.meter}</span>
                  <span className="text-body tabular-nums">
                    {floorFixed(meter.value, 1)}% {meter.state}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function Panel({
  title,
  description,
  children,
  action,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-sans text-base font-medium text-heading">{title}</h2>
          {description !== undefined && (
            <p className="mt-1 max-w-xl font-sans text-sm leading-relaxed text-body">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

const buttonBase =
  "focus-ring inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 font-sans text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const buttonTone = {
  primary: "bg-accent-solid text-on-accent hover:bg-accent-solid-hover",
  secondary:
    "border border-hairline bg-canvas text-heading hover:border-hairline-strong hover:bg-raised",
  quiet: "text-body hover:text-heading",
} as const;

export function Button({
  tone = "secondary",
  onClick,
  disabled = false,
  children,
}: {
  tone?: keyof typeof buttonTone;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${buttonBase} ${buttonTone[tone]}`}
    >
      {children}
    </button>
  );
}

/** The one chip that marks synthetic readings, wherever they are shown. */
export function DemoDataChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-raised px-2 py-0.5 font-mono text-2xs uppercase tracking-wider text-muted">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-solid" />
      Demo data
    </span>
  );
}

export function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <figure>
      <figcaption className="mb-2 font-mono text-2xs uppercase tracking-widest text-muted">
        {label}
      </figcaption>
      <pre className="overflow-x-auto rounded-lg border border-hairline bg-code p-4 font-mono text-xs leading-relaxed text-body">
        <code>{text}</code>
      </pre>
    </figure>
  );
}
