"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { floorFixed, type Advice, type MeterView, type ProviderView } from "./engine";
import {
  blocks,
  countdown,
  freshnessWord,
  meterLabel,
  noRecommendationSentence,
  pressureOf,
  providerName,
  providerOrigin,
  reasonPressure,
  reasonSentence,
  type Pressure,
} from "./language";
import { ProviderMark } from "./marks";

/**
 * The parts the dashboard is built from.
 *
 * Two rules govern all of them. Every colour is a token, either one of the
 * site's own from app/globals.css or one of the pressure tokens this route
 * adds in theme.css, so nothing here can drift from the pages around it. And
 * nothing here decides anything: a percentage, a freshness state and a reason
 * code all arrive already decided by the engine, and these components only
 * choose how to draw them.
 */

/** The meters each provider reports, used to draw a card that has no data yet. */
const EXPECTED_METERS: Record<string, readonly string[]> = {
  CLAUDE: ["FIVE_HOUR", "SEVEN_DAY"],
  OPENROUTER: ["CREDITS"],
  CODEX: ["PRIMARY"],
  ANTIGRAVITY: ["PRIMARY"],
  OPENCODE: ["PRIMARY"],
  MANUAL: ["MONTHLY"],
};

/* ------------------------------------------------------------------ meters */

/**
 * The segmented bar.
 *
 * Ten blocks, filled by the arithmetic in language.ts, drawn by the classes in
 * theme.css. The whole bar is one image to a screen reader, labelled with the
 * meter, the number and how much of it to trust, and the blocks themselves are
 * hidden from the accessibility tree because ten of them announced one at a
 * time would be noise.
 */
export function SegmentedMeter({
  value,
  state,
  label,
  size = "md",
}: {
  value: number;
  state: MeterView["state"];
  label: string;
  size?: "md" | "sm";
}) {
  const pressure: Pressure = state === "unknown" ? "none" : pressureOf(value);
  return (
    <div
      role="img"
      aria-label={label}
      data-pressure={pressure}
      data-state={state}
      className={`ol-meter min-w-0 flex-1 ${size === "sm" ? "ol-meter-sm" : ""}`}
    >
      {blocks(state === "unknown" ? 0 : value).map((fill, index) => (
        <span
          /* Ten fixed positions in a fixed order, so the index is the identity. */
          key={"block" + String(index)}
          aria-hidden="true"
          data-fill={fill}
          className="ol-meter-block"
        />
      ))}
    </div>
  );
}

function ClockGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-2.5 w-2.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6" cy="6" r="4.6" />
      <path d="M6 3.4V6l1.9 1.2" />
    </svg>
  );
}

/** Solid means read just now, hollow means aged, dimmed means never read. */
export function Freshness({ state }: { state: MeterView["state"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-2xs uppercase tracking-wider text-muted">
      <span aria-hidden="true" data-state={state} className="ol-fresh-dot" />
      {state === "stale" && <ClockGlyph />}
      {freshnessWord[state]}
    </span>
  );
}

/** One meter: its name, its freshness, its bar, its number, its countdown. */
function MeterRow({ meter, now }: { meter: MeterView; now: string }) {
  const percent = floorFixed(meter.value, 1);
  const pressure: Pressure = meter.state === "unknown" ? "none" : pressureOf(meter.value);
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-mono text-2xs uppercase tracking-widest text-soft">
          {meter.meter}
        </span>
        <Freshness state={meter.state} />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <SegmentedMeter
          value={meter.value}
          state={meter.state}
          label={meterLabel(meter, percent, now)}
        />
        {meter.state === "unknown" ? (
          <span className="w-16 shrink-0 text-right font-mono text-xs text-muted">
            unknown
          </span>
        ) : (
          <span
            data-pressure={pressure}
            data-state={meter.state}
            className="ol-pressure-text w-16 shrink-0 text-right font-mono text-sm font-medium tabular-nums"
          >
            {percent}%
          </span>
        )}
      </div>
      <p className="mt-2 font-mono text-2xs text-muted">
        {meter.state === "unknown"
          ? "nothing readable, so nothing is claimed"
          : countdown(meter.resetAt, now)}
      </p>
    </div>
  );
}

/** A meter a provider reports but has not reported yet. Never a number. */
function AbsentMeterRow({ name }: { name: string }) {
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-mono text-2xs uppercase tracking-widest text-muted">
          {name}
        </span>
        <Freshness state="unknown" />
      </div>
      <div className="mt-2 flex items-center gap-3">
        <SegmentedMeter
          value={0}
          state="unknown"
          label={name + " has no reading, so it is unknown"}
        />
        <span className="w-16 shrink-0 text-right font-mono text-xs text-muted">
          unknown
        </span>
      </div>
      <p className="mt-2 font-mono text-2xs text-muted">not zero, not exhausted</p>
    </div>
  );
}

/* ------------------------------------------------------------------- cards */

export function ProviderCard({ view, now }: { view: ProviderView; now: string }) {
  const worst = view.worst;
  const meters = view.meters;
  const expected = EXPECTED_METERS[view.provider] ?? [];
  const absent = expected.filter(
    (name) => !meters.some((meter) => meter.meter === name),
  );
  const pressure: Pressure = worst === null ? "none" : pressureOf(worst.value);

  return (
    <article
      className={`ol-sheen lift flex h-full flex-col rounded-xl border bg-surface p-4 transition-colors sm:p-5 ${
        meters.length === 0
          ? "border-dashed border-hairline-strong"
          : "border-hairline hover:border-hairline-strong"
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-hairline bg-raised text-soft">
            <ProviderMark provider={view.provider} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-sans text-sm font-medium text-heading">
              {providerName(view.provider)}
            </h3>
            <p className="mt-0.5 truncate font-mono text-2xs uppercase tracking-widest text-muted">
              {view.provider}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          {worst === null ? (
            <>
              <p className="font-mono text-base text-muted">unknown</p>
              <p className="mt-0.5 font-mono text-2xs text-muted">no reading</p>
            </>
          ) : (
            <>
              <p
                data-pressure={pressure}
                data-state={worst.state}
                className="ol-pressure-text font-mono text-lg font-medium leading-none tabular-nums"
              >
                {floorFixed(worst.value, 1)}%
              </p>
              <p className="mt-1 font-mono text-2xs text-muted">
                {meters.length === 1
                  ? "one meter"
                  : "highest of " + String(meters.length) + " meters"}
              </p>
            </>
          )}
        </div>
      </header>

      <div className="mt-4 flex-1 divide-y divide-hairline border-t border-hairline pt-3">
        {meters.map((meter) => (
          <MeterRow key={meter.meter} meter={meter} now={now} />
        ))}
        {absent.map((name) => (
          <AbsentMeterRow key={name} name={name} />
        ))}
      </div>

      <p className="mt-3 border-t border-hairline pt-3 font-mono text-2xs text-muted">
        {worst === null
          ? providerOrigin(view.provider)
          : providerOrigin(view.provider) + " · " + worst.precision}
      </p>
    </article>
  );
}

/* ------------------------------------------------------------------ header */

/**
 * The strip above the cards.
 *
 * Three facts and nothing else: what the engine calls the overall state, which
 * provider it would prefer and why, and when the reading on screen was taken.
 * Every one of them is an enum code out of the engine, printed as it is, with
 * one plain sentence underneath so the code does not have to be learned.
 */
export function HeaderStrip({
  advice,
  asOf,
  sample,
  readable,
}: {
  advice: Advice | null;
  asOf: string | null;
  sample: boolean;
  readable: number;
}) {
  const reason = advice === null || !advice.inject ? "UNKNOWN" : advice.reason;
  const pressure = reasonPressure[reason];
  const recommendation = advice?.recommendation ?? null;

  return (
    <section
      aria-label="Overall state"
      className="ol-sheen rounded-xl border border-hairline bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-hairline bg-raised px-2.5 py-1.5">
            <span aria-hidden="true" data-pressure={pressure} className="ol-pressure-dot" />
            <span className="font-mono text-xs font-medium tracking-widest text-heading">
              {reason}
            </span>
          </span>
          <p className="max-w-sm font-sans text-xs leading-relaxed text-muted">
            {reasonSentence[reason]}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 lg:justify-end">
          <div className="lg:border-l lg:border-hairline lg:pl-6">
            {recommendation !== null && recommendation.code === "PREFER" ? (
              <>
                <p className="font-mono text-xs font-medium tracking-widest text-heading">
                  PREFER {recommendation.provider}
                </p>
                <p className="mt-1 font-mono text-2xs uppercase tracking-widest text-muted">
                  {recommendation.reason}
                </p>
              </>
            ) : (
              <>
                <p className="font-mono text-xs font-medium tracking-widest text-muted">
                  NO RECOMMENDATION
                </p>
                <p className="mt-1 font-sans text-2xs leading-relaxed text-muted">
                  {recommendation === null
                    ? "Nothing has been read yet."
                    : (noRecommendationSentence[recommendation.reason] ?? "")}
                </p>
              </>
            )}
          </div>

          <div className="lg:border-l lg:border-hairline lg:pl-6">
            <p className="font-mono text-2xs uppercase tracking-widest text-muted">
              {asOf === null ? "reading the clock" : "as of " + asOf}
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              {sample ? (
                <DemoDataChip />
              ) : (
                <span className="font-mono text-2xs text-muted">
                  {readable === 0
                    ? "no meter read"
                    : readable === 1
                      ? "1 meter read"
                      : String(readable) + " meters read"}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- tabs */

export interface TabDefinition {
  id: string;
  label: string;
}

/**
 * The view switcher.
 *
 * A real tab list: arrow keys move between the tabs, Home and End jump to the
 * ends, and only the selected tab is in the tab order, which is what a screen
 * reader user expects of a tablist and what a keyboard user gets for free.
 */
export function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly TabDefinition[];
  active: string;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);

  const move = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    if (next === undefined) return;
    onSelect(next.id);
    const node = container.current?.querySelectorAll("button")[
      (index + tabs.length) % tabs.length
    ];
    node?.focus();
  };

  return (
    <div
      ref={container}
      role="tablist"
      aria-label="Dashboard views"
      className="inline-flex w-full gap-1 rounded-xl border border-hairline bg-surface p-1 sm:w-auto"
    >
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={"tab-" + tab.id}
            aria-selected={selected}
            aria-controls={"panel-" + tab.id}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onSelect(tab.id);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") {
                event.preventDefault();
                move(index + 1);
              } else if (event.key === "ArrowLeft") {
                event.preventDefault();
                move(index - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                move(0);
              } else if (event.key === "End") {
                event.preventDefault();
                move(tabs.length - 1);
              }
            }}
            className={`focus-ring-inset flex-1 whitespace-nowrap rounded-lg px-3 py-1.5 font-sans text-sm font-medium transition-colors sm:flex-none ${
              selected
                ? "bg-raised text-heading"
                : "text-muted hover:text-heading"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ empty  state */

/**
 * What the page says before it has been given anything.
 *
 * Three ways in, stated plainly, and not one invented number anywhere near
 * them. An empty dashboard is the honest state of a tool that has been handed
 * nothing, so it is designed rather than apologised for.
 */
export function EmptyState({
  onPaste,
  onSample,
}: {
  onPaste: () => void;
  onSample: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-hairline-strong bg-surface px-6 py-12 text-center sm:py-16">
      <div className="mx-auto flex w-full max-w-md flex-col items-center">
        <div
          aria-hidden="true"
          data-pressure="none"
          data-state="unknown"
          className="ol-meter mx-auto max-w-56"
        >
          {blocks(0).map((fill, index) => (
            <span
              key={"empty" + String(index)}
              data-fill={fill}
              className="ol-meter-block"
            />
          ))}
        </div>
        <h3 className="mt-6 font-sans text-base font-medium text-heading">
          No reading yet
        </h3>
        <p className="mt-2 font-sans text-sm leading-relaxed text-body">
          Nothing has been handed to this page, so every provider is unknown. It
          will stay that way until you give it a document: a missing reading is
          never shown as a zero and never as an exhausted quota.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button tone="primary" onClick={onPaste}>
            Paste a payload
          </Button>
          <Button onClick={onSample}>Load sample data</Button>
        </div>
        <p className="mt-6 font-mono text-2xs leading-relaxed text-muted">
          Or install the command line tool and run openlimiter export, then
          paste what it prints.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ shells */

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
    <section className="ol-sheen rounded-xl border border-hairline bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-sans text-base font-medium text-heading">{title}</h2>
          {description !== undefined && (
            <p className="mt-1 max-w-2xl font-sans text-sm leading-relaxed text-body">
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

/**
 * A wall clock time that never renders on the server.
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
    setRendered(Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : null);
  }, [value]);
  if (value === null) return <span className="text-muted">no reset window</span>;
  return (
    <span title={value}>
      {prefix} {rendered ?? value}
    </span>
  );
}

export { providerName };
