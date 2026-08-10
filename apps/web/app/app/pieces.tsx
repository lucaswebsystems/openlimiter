"use client";

import { useRef, type ReactNode } from "react";
import {
  failureSentence,
  floorFixed,
  type Advice,
  type FailureCategory,
  type MeterView,
  type ProviderView,
} from "./engine";
import {
  amountLine,
  amountSentence,
  blocks,
  byMeterOrder,
  countdown,
  freshnessWord,
  meterCountLabel,
  meterLabel,
  meterName,
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
 * Three rules govern all of them.
 *
 * Every colour is a token, either one of the site's own from app/globals.css
 * or one of the pressure tokens this route adds in theme.css, so nothing here
 * can drift from the pages around it. Every card, chip, button and radius is
 * the site's own shape, taken from components/ui.tsx rather than re invented,
 * which is why the two surfaces read as one product.
 *
 * Type is split by what a thing is rather than by where it sits. The monospace
 * face carries code and only code: a provider's enum code, an engine reason
 * code, a clock reading, and the blocks an agent would actually be handed.
 * Every label, name, heading, button and sentence is the same system sans the
 * rest of the site is set in.
 *
 * And nothing here decides anything: a percentage, a freshness state and a
 * reason code all arrive already decided by the engine, and these components
 * only choose how to draw them.
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

/* ------------------------------------------------------------------ shapes */

/** The site's card, verbatim, plus the one pixel of light along its top. */
const CARD_SURFACE =
  "ol-sheen rounded-xl border border-hairline bg-surface";

/** The site's chip: a pill, a hairline, twelve pixel text. */
const CHIP = "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs";

const CHIP_NEUTRAL = `${CHIP} border-hairline bg-raised text-muted`;
const CHIP_STRONG = `${CHIP} border-hairline bg-raised text-heading`;
const CHIP_ACCENT = `${CHIP} border-accent-subtle bg-accent-subtle text-accent`;

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
    <span className="inline-flex flex-none items-center gap-1.5 text-2xs text-muted">
      <span aria-hidden="true" data-state={state} className="ol-fresh-dot" />
      {state === "stale" && <ClockGlyph />}
      {freshnessWord[state]}
    </span>
  );
}

/**
 * What a meter reads, to the right of its bar.
 *
 * Two shapes, because two kinds of plan are being described. A rationed plan
 * has spent a share of a window, and the percentage is the reading. A plan
 * bought in credits has spent money, and the money is the reading: the dollars
 * lead, in the bar's own colour, and the percentage drops to the line
 * underneath where it belongs.
 */
function MeterReading({
  meter,
  percent,
  pressure,
}: {
  meter: MeterView;
  percent: string;
  pressure: Pressure;
}) {
  const money = amountLine(meter);

  if (meter.state === "unknown") {
    return <span className="w-14 shrink-0 text-right text-xs text-muted">Unknown</span>;
  }

  if (money !== null) {
    return (
      <span className="shrink-0 text-right leading-tight">
        <span className="block">
          <span
            data-pressure={pressure}
            className="ol-pressure-text text-sm font-medium tabular-nums"
          >
            {money.spent}
          </span>
          <span className="text-2xs text-muted"> spent</span>
        </span>
        <span className="ol-amount-line block text-2xs tabular-nums">
          of {money.loaded} loaded
        </span>
      </span>
    );
  }

  return (
    <span
      data-pressure={pressure}
      data-state={meter.state}
      className="ol-pressure-text w-14 shrink-0 text-right text-sm font-medium tabular-nums"
    >
      {percent}%
    </span>
  );
}

/** One meter: its name, its freshness, its bar, its reading, its countdown. */
function MeterRow({ meter, now }: { meter: MeterView; now: string }) {
  const percent = floorFixed(meter.value, 1);
  const pressure: Pressure = meter.state === "unknown" ? "none" : pressureOf(meter.value);
  const priced = amountSentence(meter) !== null;

  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm text-soft">{meterName(meter.meter)}</span>
        <Freshness state={meter.state} />
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        <SegmentedMeter
          value={meter.value}
          state={meter.state}
          label={meterLabel(meter, percent, now)}
        />
        <MeterReading meter={meter} percent={percent} pressure={pressure} />
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-2xs text-muted">
        {priced && meter.state !== "unknown" && (
          <>
            <span className="tabular-nums">{percent}% used</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <span>
          {meter.state === "unknown"
            ? "Nothing readable, so nothing is claimed"
            : countdown(meter.resetAt, now)}
        </span>
      </div>
    </div>
  );
}

/**
 * The one line a card shows when something went wrong.
 *
 * The sentence is a constant out of the engine, keyed by a category the engine
 * chose. Nothing a provider wrote can reach this element, which is the whole
 * reason the vocabulary exists rather than a message string being passed up.
 */
function FailureLine({ category }: { category: FailureCategory }) {
  return (
    <p
      role="status"
      data-failure={category}
      className="ol-error-line mt-3 flex items-start gap-1.5 border-t border-hairline pt-3 text-xs leading-relaxed"
    >
      <span aria-hidden="true">!</span>
      <span>{failureSentence[category]}</span>
    </p>
  );
}

/** A meter a provider reports but has not reported yet. Never a number. */
function AbsentMeterRow({ code }: { code: string }) {
  const name = meterName(code);
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm text-muted">{name}</span>
        <Freshness state="unknown" />
      </div>
      <div className="mt-2.5 flex items-center gap-3">
        <SegmentedMeter
          value={0}
          state="unknown"
          label={name + " has no reading, so it is unknown"}
        />
        <span className="w-14 shrink-0 text-right text-xs text-muted">Unknown</span>
      </div>
      <p className="mt-2 text-2xs text-muted">Not zero, not exhausted</p>
    </div>
  );
}

/* ------------------------------------------------------------------- cards */

/**
 * A provider, and every meter it carries.
 *
 * The rows are in the order somebody reads them, shortest window first and
 * money last, and there are exactly as many of them as the data has. Nothing
 * here knows how many that is: a provider that starts reporting a third window
 * grows a third row on its own.
 */
export function ProviderCard({ view, now }: { view: ProviderView; now: string }) {
  const worst = view.worst;
  const meters = [...view.meters].sort((left, right) =>
    byMeterOrder(left.meter, right.meter),
  );
  const expected = EXPECTED_METERS[view.provider] ?? [];
  const absent = expected
    .filter((code) => !meters.some((meter) => meter.meter === code))
    .sort(byMeterOrder);
  const pressure: Pressure = worst === null ? "none" : pressureOf(worst.value);
  const count = meterCountLabel(meters.length);

  return (
    <article
      className={`ol-rise lift flex flex-col p-5 transition-colors ${CARD_SURFACE} ${
        meters.length === 0
          ? "border-dashed border-hairline-strong"
          : "hover:border-hairline-strong hover:bg-raised"
      }`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-hairline bg-raised text-soft">
            <ProviderMark provider={view.provider} />
          </span>
          <div className="min-w-0">
            <h3 className="ol-brand-font truncate text-sm text-heading">
              {providerName(view.provider)}
            </h3>
            <p className="mt-0.5 truncate font-mono text-2xs uppercase tracking-widest text-muted">
              {view.provider}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {worst === null ? (
            <p className="text-sm text-muted">No reading</p>
          ) : (
            <p
              data-pressure={pressure}
              data-state={worst.state}
              className="ol-pressure-text text-2xl font-medium leading-none tabular-nums"
            >
              {floorFixed(worst.value, 1)}%
            </p>
          )}
          {count !== null && <span className={CHIP_NEUTRAL}>{count}</span>}
        </div>
      </header>

      <div className="mt-4 divide-y divide-hairline border-t border-hairline pt-3">
        {meters.map((meter) => (
          <MeterRow key={meter.meter} meter={meter} now={now} />
        ))}
        {absent.map((code) => (
          <AbsentMeterRow key={code} code={code} />
        ))}
      </div>

      {view.failure !== null && <FailureLine category={view.failure} />}

      <p className="mt-3 border-t border-hairline pt-3 text-2xs text-muted">
        {worst === null
          ? providerOrigin(view.provider)
          : providerOrigin(view.provider) + " · " + worst.precision}
      </p>
    </article>
  );
}

/* -------------------------------------------------------------- list view */

/**
 * The same readings as a dense table.
 *
 * One row per meter rather than one card per provider, which is what somebody
 * with six providers and ten meters actually wants to scan. It is built from
 * exactly the same `ProviderView` list the grid renders, so the two views can
 * never disagree, and it is a grid with table roles rather than a `<table>`
 * because the row has to fold at phone width and a table cannot be refolded.
 *
 * A provider's name appears once per group. On the rows underneath it is still
 * in the markup, and still announced, but carried in a visually hidden span so
 * a screen reader hears which provider a row belongs to while the eye reads a
 * clean block. The group's first row carries the hairline that separates it
 * from the one above.
 */
export function MeterList({
  providers,
  now,
}: {
  providers: readonly ProviderView[];
  now: string;
}) {
  const groups = providers
    .map((provider) => ({
      provider,
      meters: [...provider.meters].sort((left, right) =>
        byMeterOrder(left.meter, right.meter),
      ),
    }))
    .filter((group) => group.meters.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className={`ol-rise overflow-hidden ${CARD_SURFACE}`}>
      <div role="table" aria-label="Every meter, one row each" className="ol-list">
        <div role="rowgroup">
          <div role="row" className="ol-list-row ol-list-head">
            <span role="columnheader" className="ol-cell-ident">
              Provider
            </span>
            <span role="columnheader" className="ol-cell-meter">
              Meter
            </span>
            <span role="columnheader" className="ol-cell-bar">
              Level
            </span>
            <span role="columnheader" className="ol-cell-value">
              Used
            </span>
            <span role="columnheader" className="ol-cell-money">
              Money
            </span>
            <span role="columnheader" className="ol-cell-state">
              Reading
            </span>
            <span role="columnheader" className="ol-cell-reset">
              Resets
            </span>
          </div>
        </div>

        {groups.map((group) => (
          <div role="rowgroup" key={group.provider.provider}>
            {group.meters.map((meter, index) => {
              const percent = floorFixed(meter.value, 1);
              const pressure: Pressure =
                meter.state === "unknown" ? "none" : pressureOf(meter.value);
              const money = amountLine(meter);
              return (
                <div
                  role="row"
                  key={group.provider.provider + meter.meter}
                  data-group-start={index === 0 ? "" : undefined}
                  className="ol-list-row"
                >
                  <span role="cell" className="ol-cell-ident">
                    {index === 0 ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="text-soft">
                          <ProviderMark provider={group.provider.provider} />
                        </span>
                        <span className="ol-brand-font truncate text-sm text-heading">
                          {providerName(group.provider.provider)}
                        </span>
                      </span>
                    ) : (
                      <span className="sr-only">
                        {providerName(group.provider.provider)}
                      </span>
                    )}
                  </span>
                  <span role="cell" className="ol-cell-meter truncate text-sm text-soft">
                    {meterName(meter.meter)}
                  </span>
                  <span role="cell" className="ol-cell-bar">
                    <SegmentedMeter
                      value={meter.value}
                      state={meter.state}
                      size="sm"
                      label={meterLabel(meter, percent, now)}
                    />
                  </span>
                  <span
                    role="cell"
                    data-pressure={pressure}
                    className="ol-cell-value ol-pressure-text text-sm font-medium tabular-nums"
                  >
                    {meter.state === "unknown" ? "Unknown" : percent + "%"}
                  </span>
                  <span
                    role="cell"
                    className="ol-cell-money ol-amount-line text-2xs tabular-nums"
                  >
                    {money === null ? "" : money.spent + " of " + money.loaded}
                  </span>
                  <span role="cell" className="ol-cell-state">
                    <Freshness state={meter.state} />
                  </span>
                  <span role="cell" className="ol-cell-reset text-2xs text-muted">
                    {meter.state === "unknown"
                      ? "Not zero, not exhausted"
                      : countdown(meter.resetAt, now)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- view switch */

export type ViewMode = "grid" | "list";

function GridGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
    </svg>
  );
}

function ListGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </svg>
  );
}

/**
 * Grid or list, as a segmented control.
 *
 * Two toggle buttons rather than a tab list, because these do not switch
 * between panels of different content: they are two drawings of one thing, and
 * `aria-pressed` is what says which drawing is on.
 */
export function ViewSwitch({
  view,
  onSelect,
}: {
  view: ViewMode;
  onSelect: (next: ViewMode) => void;
}) {
  const options: readonly { id: ViewMode; label: string; glyph: ReactNode }[] = [
    { id: "grid", label: "Grid", glyph: <GridGlyph /> },
    { id: "list", label: "List", glyph: <ListGlyph /> },
  ];
  return (
    <div
      role="group"
      aria-label="How the meters are laid out"
      className="inline-flex items-center gap-1 rounded-lg border border-hairline bg-surface p-1"
    >
      {options.map((option) => {
        const on = option.id === view;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            title={option.label + " view"}
            onClick={() => {
              onSelect(option.id);
            }}
            className={`ol-tap focus-ring-inset inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
              on ? "bg-raised text-heading" : "text-muted hover:text-heading"
            }`}
          >
            {option.glyph}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ header */

/**
 * The strip above the cards, which is this application's own title bar.
 *
 * The lockup is the real one: the ring mark and the wordmark in Baloo 2, at
 * the proportion the site header uses, rendered on the server and handed down
 * as a prop so the font never enters this bundle. Beside it sit the three
 * facts the engine has to offer, every one of them an enum code printed as it
 * is with one plain sentence underneath so the code does not have to be
 * learned: what it calls the overall state, which provider it would prefer and
 * why, and when the reading on screen was taken.
 */
export function HeaderStrip({
  lockup,
  advice,
  asOf,
  sample,
  busy,
  onRefresh,
  actions,
}: {
  lockup: ReactNode;
  advice: Advice | null;
  asOf: string | null;
  sample: boolean;
  busy: boolean;
  onRefresh: () => void;
  actions?: ReactNode;
}) {
  const reason = advice === null || !advice.inject ? "UNKNOWN" : advice.reason;
  const pressure = reasonPressure[reason];
  const recommendation = advice?.recommendation ?? null;

  return (
    <section aria-label="Overall state" className={`ol-rise ${CARD_SURFACE}`}>
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        {lockup}
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Button tone="ghost" onClick={onRefresh} disabled={busy}>
            <RefreshGlyph spinning={busy} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-hairline px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span className={CHIP_STRONG}>
            <span aria-hidden="true" data-pressure={pressure} className="ol-pressure-dot" />
            <span className="font-mono tracking-widest">{reason}</span>
          </span>
          <p className="max-w-sm text-xs leading-relaxed text-muted">
            {reasonSentence[reason]}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 lg:justify-end">
          {recommendation !== null && recommendation.code === "PREFER" ? (
            <span className={CHIP_ACCENT} title="The provider the engine would route to next">
              <span className="font-mono tracking-widest">
                PREFER {recommendation.provider}
              </span>
              <span className="font-mono text-2xs tracking-widest">
                {recommendation.reason}
              </span>
            </span>
          ) : (
            <span className={CHIP_NEUTRAL}>
              <span className="font-mono tracking-widest">NO RECOMMENDATION</span>
            </span>
          )}
          {recommendation !== null && recommendation.code === "NONE" && (
            <p className="text-xs text-muted">
              {noRecommendationSentence[recommendation.reason] ?? ""}
            </p>
          )}
          <span className="font-mono text-2xs text-muted">
            {asOf === null ? "reading the clock" : "as of " + asOf}
          </span>
          {sample && <DemoDataChip />}
        </div>
      </div>
    </section>
  );
}

function RefreshGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 11a8 8 0 1 0-.7 4.3" />
      <path d="M20 5.5V11h-5.5" />
    </svg>
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
            className={`ol-brand-font ol-tap focus-ring-inset flex-1 cursor-pointer whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm sm:flex-none ${
              selected ? "bg-raised text-heading" : "text-muted hover:text-heading"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- skeletons */

/**
 * What the grid looks like while a document is being read.
 *
 * Three cards at the shape the real ones take, in the surface tones the real
 * ones use, so nothing on the page moves when the readings arrive. They are
 * hidden from the accessibility tree and the state is announced once, in
 * words, by the live region beside them.
 */
export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      {Array.from({ length: count }, (_unused, index) => (
        <div key={"skeleton" + String(index)} className={`${CARD_SURFACE} p-5`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="ol-skeleton block h-9 w-9" />
              <span className="space-y-1.5">
                <span className="ol-skeleton block h-3 w-24" />
                <span className="ol-skeleton block h-2 w-14" />
              </span>
            </div>
            <span className="ol-skeleton block h-6 w-14" />
          </div>
          <div className="mt-5 space-y-5 border-t border-hairline pt-4">
            {[0, 1].map((row) => (
              <div key={"row" + String(row)} className="space-y-2.5">
                <span className="ol-skeleton block h-2.5 w-28" />
                <span className="ol-skeleton block h-2 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
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
    <div
      className="ol-rise rounded-xl border border-dashed border-hairline-strong bg-surface px-6 py-12 text-center sm:py-16"
    >
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
        <h3 className="ol-brand-font mt-6 text-base text-heading">No reading yet</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">
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
        <p className="mt-6 text-xs leading-relaxed text-muted">
          Or install the command line tool and run{" "}
          <code className="font-mono text-heading">openlimiter export</code>, then
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
    <section className={`ol-rise ${CARD_SURFACE} p-5 sm:p-6`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="ol-brand-font text-base text-heading">{title}</h2>
          {description !== undefined && (
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
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

/**
 * The button, at the site's own metrics.
 *
 * Thirty eight pixels tall, an eight pixel radius, sixteen pixels of
 * horizontal padding and fourteen pixel medium text, with a border on every
 * tone so a filled control and a ghost one line up on the same row. These are
 * the strings components/ui.tsx uses for the marketing pages, as an element
 * that can be pressed rather than one that navigates.
 */
const buttonBase =
  "ol-tap lift-sm focus-ring inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

const buttonTone = {
  primary: "border-transparent bg-solid text-on-solid hover:bg-solid-hover",
  ghost:
    "border-hairline-strong bg-transparent text-heading hover:border-heading hover:bg-surface",
  quiet: "border-transparent text-muted hover:text-heading",
} as const;

export function Button({
  tone = "ghost",
  onClick,
  disabled = false,
  label,
  children,
}: {
  tone?: keyof typeof buttonTone;
  onClick: () => void;
  disabled?: boolean;
  /** Accessible name, for a control whose text alone is not enough. */
  label?: string;
  children: ReactNode;
}) {
  const naming = label === undefined ? {} : { "aria-label": label, title: label };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...naming}
      className={`${buttonBase} ${buttonTone[tone]}`}
    >
      {children}
    </button>
  );
}

/** The one chip that marks synthetic readings, wherever they are shown. */
export function DemoDataChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-raised px-2 py-1 font-mono text-2xs uppercase tracking-wider text-muted">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-solid" />
      Demo data
    </span>
  );
}

export function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <figure>
      <figcaption className="mb-2 text-2xs uppercase tracking-widest text-muted">
        {label}
      </figcaption>
      <pre className="overflow-x-auto rounded-lg border border-hairline bg-code p-4 font-mono text-xs leading-relaxed text-body">
        <code>{text}</code>
      </pre>
    </figure>
  );
}
