"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  connectionSentence,
  failureSentence,
  floorFixed,
  queryCatalogueRows,
  type Advice,
  type CatalogueRow,
  type FailureCategory,
  type MeterView,
  type PlannedProviderEntry,
  type ProviderCatalogueEntry,
  type ProviderView,
} from "./engine";
import {
  CONNECTION_FACTS,
  amountLine,
  amountSentence,
  byMeterOrder,
  countdown,
  freshnessWord,
  meterFraction,
  meterLabel,
  meterName,
  meterWidth,
  pressureOf,
  providerName,
  providerOrigin,
  reasonPressure,
  sourceStateLabel,
  sourceStateOf,
  sourceStateSentence,
  type Pressure,
  type SourceState,
} from "./language";
import registry from "../../lib/provider-specs.generated.json";
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
 * The bar, and it is continuous.
 *
 * It used to be ten blocks with a half step every five percent, which meant the
 * bar only moved twice per ten points: 91 and 97 drew the same picture, and a
 * weekly window four days apart looked untouched. A quota meter whose whole job
 * is to show how much room is left cannot round the room away. So the fill is
 * the number, `width` set from the clamped percentage with every decimal the
 * source carried, and the only arithmetic between the reading and the pixels is
 * the clamp that keeps a track from being longer than itself.
 *
 * Colour and geometry are independent. The four pressure bands paint the fill
 * and never touch its length, which is what lets a red bar and an orange bar be
 * compared by eye.
 *
 * It is a real `progressbar`, so `aria-valuenow` carries the exact reading
 * rather than the drawn approximation of it. Unknown is the one case with no
 * `aria-valuenow` at all, which is how ARIA spells a progressbar that has no
 * value: an absent reading is not zero, and a zero width fill on a full width
 * track is exactly the lie this component exists to stop telling.
 *
 * `aria-valuetext` is the spoken form, and it is here because exact and
 * speakable are not the same requirement. A credit balance of 12.47 out of 20
 * is 62.35000000000001 in binary floating point, and that is the honest value
 * to expose programmatically and an absurd thing to read aloud one digit at a
 * time. So the number stays exact and the sentence stays short.
 */
export function QuotaMeter({
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
  const unknown = state === "unknown";
  const exact = unknown ? null : meterFraction(value);
  const width = unknown ? null : meterWidth(value);
  const pressure: Pressure = exact === null ? "none" : pressureOf(value);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(exact === null
        ? { "aria-valuetext": "Unknown" }
        : { "aria-valuenow": exact, "aria-valuetext": floorFixed(exact, 1) + "% used" })}
      data-pressure={pressure}
      data-state={state}
      className={`ol-meter min-w-0 flex-1 ${size === "sm" ? "ol-meter-sm" : ""}`}
    >
      {width === null ? (
        /* Neutral track, no fill element at all, and the word itself at the
           size that can hold it. The compact bar in the list has no room for a
           word and does not need one: its row carries an Unknown cell. */
        size === "md" && <span className="ol-meter-word">Unknown</span>
      ) : (
        <span aria-hidden="true" className="ol-meter-fill" style={{ width }} />
      )}
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

  /* The bar itself says Unknown, in the track, so nothing is repeated here. */
  if (meter.state === "unknown") return null;

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
        <QuotaMeter
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
        <QuotaMeter
          value={Number.NaN}
          state="unknown"
          label={name + " has no reading, so it is unknown"}
        />
      </div>
      <p className="mt-2 text-2xs text-muted">Not zero, not exhausted</p>
    </div>
  );
}

/* ------------------------------------------------------------------- cards */

/* --------------------------------------------------------- connection chip */

/**
 * What this provider's numbers actually came from.
 *
 * The one word this chip will never say is connected. Five of the six parsers
 * here have no reader behind them, so a card showing a full bar has to say, on
 * the card, that somebody handed it that document. The label is the sentence
 * form a person reads and the enum is on the element for anyone quoting it in a
 * bug report, which is the same split the provider code line makes.
 */
export function SourceChip({ state }: { state: SourceState }) {
  return (
    <span
      data-source={state}
      title={state + ". " + sourceStateSentence[state]}
      className={`${CHIP_NEUTRAL} flex-none`}
    >
      <span aria-hidden="true" className="ol-source-dot" />
      {sourceStateLabel[state]}
    </span>
  );
}

/**
 * A provider, and every meter it carries.
 *
 * The rows are in the order somebody reads them, shortest window first and
 * money last, and there are exactly as many of them as the data has. Nothing
 * here knows how many that is: a provider that starts reporting a third window
 * grows a third row on its own.
 *
 * A card is only ever drawn for a provider that has something to say. The
 * decision is the dashboard's, not this component's, because an empty card for
 * every unconfigured provider was the wall of Unknown the first launch used to
 * open on.
 */
export function ProviderCard({
  view,
  now,
  demo = false,
}: {
  view: ProviderView;
  now: string;
  demo?: boolean;
}) {
  const worst = view.worst;
  const meters = [...view.meters].sort((left, right) => {
    const diff = right.value - left.value;
    return diff !== 0 ? diff : byMeterOrder(left.meter, right.meter);
  });
  const expected = EXPECTED_METERS[view.provider] ?? [];
  const absent = expected
    .filter((code) => !meters.some((meter) => meter.meter === code))
    .sort(byMeterOrder);
  const pressure: Pressure = worst === null ? "none" : pressureOf(worst.value);
  /* One row answers for the card, and its source literal and its provenance
     have to come from that same row: pairing one meter's stamp with another
     meter's literal is how a card ends up describing an arrival nothing here
     actually saw. */
  const lead = worst ?? meters[0];
  const source = sourceStateOf(view.provider, lead?.source, lead?.provenance);

  return (
    <article
      data-demo={demo ? "" : undefined}
      className={`ol-rise lift flex flex-col p-5 transition-colors ${CARD_SURFACE} ${
        meters.length === 0
          ? "border-dashed border-hairline-strong"
          : "hover:border-hairline-strong hover:bg-raised"
      }`}
    >
      {demo && <DemoStrip />}
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

      <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t border-hairline pt-3">
        <SourceChip state={source} />
        <p className="text-2xs text-muted">
          {worst === null
            ? providerOrigin(view.provider)
            : providerOrigin(view.provider) + " · " + worst.precision}
        </p>
      </div>
    </article>
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
  demo,
  busy,
  onRefresh,
  actions,
}: {
  lockup: ReactNode;
  advice: Advice | null;
  asOf: string | null;
  demo: boolean;
  busy: boolean;
  onRefresh: () => void;
  actions?: ReactNode;
}) {
  const reason = advice === null || !advice.inject ? "UNKNOWN" : advice.reason;
  const pressure = reasonPressure[reason];
  const recommendation = advice?.recommendation ?? null;

  return (
    <section
      aria-label="Overall state"
      data-demo={demo ? "" : undefined}
      /* Never clipped: the settings disclosure opens out of this panel. */
      className={`ol-rise ${CARD_SURFACE}`}
    >
      {demo && <DemoStrip className="" />}
      <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        {lockup}
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Button
            tone="ghost"
            onClick={onRefresh}
            disabled={busy}
            title="Reads this device's stored reading again and advances the clock. Nothing is fetched from a provider."
          >
            {/* Not `Refresh`. That word promises a round trip to somebody's
                account, and this button cannot reach one: it re-reads what is
                already on the device. The desktop window's equivalent says the
                same thing, so the two surfaces describe one action once. */}
            <RefreshGlyph spinning={busy} />
            Re-read local data
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-4 border-t border-hairline px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span className={CHIP_STRONG}>
            <span aria-hidden="true" data-pressure={pressure} className="ol-pressure-dot" />
            <span className="font-mono tracking-widest">{reason}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 lg:justify-end">
          {recommendation !== null && recommendation.code === "PREFER" && (
            <span className={CHIP_ACCENT} title="The provider the engine would route to next">
              <span className="font-mono tracking-widest">
                PREFER {recommendation.provider}
              </span>
              <span className="font-mono text-2xs tracking-widest">
                {recommendation.reason}
              </span>
            </span>
          )}
          <span className="font-mono text-2xs text-muted">
            {asOf === null ? "reading the clock" : "as of " + asOf}
          </span>
          {demo && <DemoDataChip />}
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

/* ------------------------------------------------------------- first launch */

/**
 * What the page says before it has been given anything.
 *
 * It used to open on a full grid of Unknown cards, one per provider, each with
 * an empty bar in it. That is a parser debugging view: it reads as six broken
 * connections rather than as a tool nobody has set up yet, and an empty bar
 * beside a provider's name is the closest thing to a fabricated zero this
 * product can draw without inventing a number.
 *
 * So the first launch is one calm block with one action in it. The cards arrive
 * when there is something to put in them.
 */
export function FirstRunState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="ol-rise rounded-xl border border-hairline bg-surface px-6 py-14 text-center sm:py-20">
      <div className="mx-auto flex w-full max-w-md flex-col items-center">
        <span
          aria-hidden="true"
          className="grid h-12 w-12 place-items-center rounded-xl border border-hairline bg-raised text-soft"
        >
          <PlugGlyph />
        </span>
        <h3 className="ol-brand-font mt-5 text-lg text-heading">
          No providers are connected yet
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          OpenLimiter reads the tools already running on this machine and the
          accounts it supports. Until one of them reports, nothing here is a
          number: a provider with no reading is never drawn as a zero.
        </p>
        <div className="mt-7">
          <Button tone="primary" onClick={onConnect}>
            Set up providers
          </Button>
        </div>
      </div>
    </div>
  );
}

function PlugGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 3v6M15 3v6" />
      <path d="M6 9h12v3a6 6 0 0 1-12 0Z" />
      <path d="M12 18v3" />
    </svg>
  );
}

/* ---------------------------------------------------------- provider catalogue */

/*
 * What a browser can honestly claim about each connectable provider.
 *
 * This page holds no credential and makes no provider request, so every
 * connectable provider is import only here whatever the desktop application
 * can do. The same answer already lives in CONNECTION_FACTS in language.ts,
 * and the two must never disagree.
 */
const BROWSER_CATALOGUE_STATES = {
  claude: "IMPORT_ONLY",
  openrouter: "IMPORT_ONLY",
  codex: "IMPORT_ONLY",
  antigravity: "IMPORT_ONLY",
  opencode: "IMPORT_ONLY",
} as const;

/**
 * Every provider OpenLimiter knows about, read from the generated catalogue.
 *
 * This is a read only list. The page cannot connect anything, so nothing here
 * is drawn as a button or a link that could be mistaken for a connect action.
 * Connectable rows say what state the browser honestly sees them in and what
 * the core state machine would do next; planned rows simply say OpenLimiter
 * does not read them yet.
 */
export function ProviderCatalogue() {
  const rows = queryCatalogueRows(registry, BROWSER_CATALOGUE_STATES);

  return (
    <ul className="divide-y divide-hairline border-t border-hairline">
      {rows.map((row) => (
        <li key={rowKey(row)} className="py-4">
          {row.availability === "connectable" ? (
            <ConnectableCatalogueRow row={row} />
          ) : (
            <PlannedCatalogueRow row={row} />
          )}
        </li>
      ))}
    </ul>
  );
}

function rowKey(row: CatalogueRow): string {
  return row.availability === "connectable" ? row.providerId : row.specId;
}

function ConnectableCatalogueRow({ row }: { row: ProviderCatalogueEntry }) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="ol-brand-font min-w-0 truncate text-sm text-heading">
            {row.displayName}
          </span>
          <span className={`${CHIP_NEUTRAL} flex-none`}>
            <span className="font-mono tracking-widest">
              {row.connectionState}
            </span>
          </span>
        </div>
        <p className="text-xs text-muted">{row.action}</p>
      </div>
      <p className="text-xs leading-relaxed text-body">
        {connectionSentence[row.connectionState]}
      </p>
      <div className="flex flex-wrap gap-x-2 gap-y-1 text-2xs text-muted">
        <span>Windows: {row.capabilities.windows.label}</span>
        <span>macOS: {row.capabilities.macos.label}</span>
        <span>Linux: {row.capabilities.linux.label}</span>
      </div>
    </div>
  );
}

function PlannedCatalogueRow({ row }: { row: PlannedProviderEntry }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="ol-brand-font min-w-0 truncate text-sm text-heading">
          {row.displayName}
        </span>
        <span className={`${CHIP_NEUTRAL} flex-none`}>Planned</span>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        OpenLimiter does not read this product yet.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- connections */

/**
 * What can actually be connected today, one block per provider.
 *
 * This is the page the first launch sends somebody to, and the honest answer
 * is that one provider reports on its own, in the tools on a machine, and
 * everything on THIS page arrives as a document. Each block carries two
 * layers of that truth: the product wide chip and line it always carried,
 * and underneath, the connection state machine's own sentence and next
 * action for what this browser surface can do, with the statusline wiring
 * for Claude and the document path for every import only provider. The
 * sentences come from packages/core, so a block here and a card on the
 * desktop describe one state with one sentence.
 */
function getHonestyBadges(providerId: string): string[] {
  const providers = (registry as { providers?: Array<{ honesty?: { connectorId?: string; verification?: string; credentialOrigin?: string; dataInterfaceStatus?: string; automationRisk?: string } }> }).providers ?? [];
  const spec = providers.find(
    (p) => (p.honesty?.connectorId ?? "").toUpperCase() === providerId.toUpperCase()
  );
  if (!spec?.honesty) return ["UNVERIFIED", "user-key", "documented-api", "low"];
  const h = spec.honesty;
  return [h.verification, h.credentialOrigin, h.dataInterfaceStatus, h.automationRisk].filter(Boolean) as string[];
}

export function ConnectionList({
  onImportFile,
  onEnterDemo,
}: {
  onImportFile?: () => void;
  onEnterDemo?: () => void;
}) {
  return (
    <ul className="divide-y divide-hairline border-t border-hairline">
      {CONNECTION_FACTS.map((fact) => (
        <li key={fact.provider} className="py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="grid h-7 w-7 flex-none place-items-center rounded-md border border-hairline bg-raised text-soft">
                <ProviderMark provider={fact.provider} />
              </span>
              <span className="ol-brand-font min-w-0 truncate text-sm text-heading">
                {providerName(fact.provider)}
              </span>
              <span className={`${CHIP_NEUTRAL} flex-none`}>
                <span className="font-mono tracking-widest">
                  {fact.browserState}
                </span>
              </span>
            </div>
            {onImportFile && (
              <Button tone="ghost" onClick={onImportFile} className="text-xs">
                {fact.provider === "MANUAL" ? "Add manual entry" : "Choose file"}
              </Button>
            )}
          </div>

          <details className="mt-3 text-xs">
            <summary className="cursor-pointer select-none font-medium text-muted hover:text-heading">
              Why this is needed
            </summary>
            <div className="mt-2 space-y-2 rounded-lg border border-hairline bg-raised p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                {getHonestyBadges(fact.provider).map((badge) => (
                  <span key={badge} className={`${CHIP_NEUTRAL} flex-none`}>
                    {badge}
                  </span>
                ))}
              </div>
              <p className="text-xs leading-relaxed text-muted">{fact.line}</p>
              <p className="text-xs leading-relaxed text-body">
                {connectionSentence[fact.browserState]}
              </p>
            </div>
          </details>
        </li>
      ))}

      <li key="DEMO" className="py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="grid h-7 w-7 flex-none place-items-center rounded-md border border-hairline bg-raised text-soft">
              <SparkGlyph />
            </span>
            <span className="ol-brand-font min-w-0 truncate text-sm text-heading">
              Demo mode
            </span>
            <span className={CHIP_NEUTRAL}>SYNTHETIC</span>
          </div>
          {onEnterDemo && (
            <Button tone="primary" onClick={onEnterDemo} className="text-xs">
              Explore demo mode
            </Button>
          )}
        </div>

        <details className="mt-3 text-xs">
          <summary className="cursor-pointer select-none font-medium text-muted hover:text-heading">
            Why this is needed
          </summary>
          <div className="mt-2 space-y-2 rounded-lg border border-hairline bg-raised p-3">
            <p className="text-xs leading-relaxed text-muted">
              Explore the dashboard with synthetic fixture data to see how quota
              meters and reset countdowns behave without connecting real accounts.
            </p>
            <p className="text-xs leading-relaxed text-body">
              Loads synthetic fixtures without reading any account. Real readings stay untouched.
            </p>
          </div>
        </details>
      </li>
    </ul>
  );
}

function SparkGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m12 3 1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3Z" />
    </svg>
  );
}

/* -------------------------------------------------------------------- demo */

/**
 * The mark that says these numbers are made up.
 *
 * It is a strip rather than a chip because it has to survive a screenshot. One
 * of these sits on every panel that can show a reading, the header included and
 * every provider card included, so no crop of this page can be mistaken for an
 * account. The banner above them all carries the way out.
 */
export function DemoStrip({ className = "-mx-5 -mt-5 mb-4" }: { className?: string }) {
  return (
    <p className={`ol-demo-strip ${className}`}>
      <span aria-hidden="true" className="ol-demo-dot" />
      Demo data · synthetic
    </p>
  );
}

/**
 * The banner across the top of the application while demo mode is on.
 *
 * Live readings are untouched behind it, in their own store, and the button
 * here is the only thing that puts them back on screen. Nothing about this is
 * dismissible: a demo watermark somebody can close is a watermark that will be
 * missing from the screenshot that matters.
 */
export function DemoBanner({ onLeave }: { onLeave: () => void }) {
  return (
    <div role="status" className="ol-demo-banner">
      <p className="ol-demo-banner-text">
        <span aria-hidden="true" className="ol-demo-dot" />
        <span className="ol-demo-banner-title">Demo data</span>
        <span className="ol-demo-banner-detail">
          Every number below is synthetic. No account was read, and your own
          readings are untouched.
        </span>
      </p>
      <Button tone="ghost" onClick={onLeave} className="flex-none">
        Leave demo mode
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- settings */

function GearGlyph() {
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
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.56-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.49 1.03Z" />
    </svg>
  );
}

/**
 * Settings, and the one drawer under it that developers need.
 *
 * Demo mode lives here and nowhere else. It used to be a button called Load
 * sample data sitting in the main toolbar beside Clear, one click away from the
 * live view and indistinguishable from it afterwards, which is precisely how a
 * synthetic reading ends up in somebody's screenshot of their own quota. Behind
 * a gear it is still two clicks from anyone who wants it and no clicks from
 * anyone who does not.
 *
 * The panel closes on Escape and on a press outside it, and the button carries
 * its own expanded state, so the whole thing behaves like the disclosure it is.
 */
export function SettingsMenu({
  demo,
  onEnterDemo,
  onLeaveDemo,
  onClear,
  clearable,
}: {
  demo: boolean;
  onEnterDemo: () => void;
  onLeaveDemo: () => void;
  onClear: () => void;
  clearable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
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
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="Settings"
        title="Settings"
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={`ol-tap focus-ring inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-hairline-strong text-heading hover:border-heading hover:bg-surface ${
          open ? "bg-surface" : "bg-transparent"
        }`}
      >
        <GearGlyph />
      </button>

      {open && (
        <div className="ol-menu" role="group" aria-label="Settings">
          <p className="ol-menu-label">Developer</p>
          <div className="px-3 pb-3">
            <p className="ol-brand-font text-sm text-heading">Demo mode</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Fills the dashboard with the project&apos;s own synthetic fixtures,
              in a separate store, watermarked everywhere. Your readings stay
              where they are and come back when you leave.
            </p>
            <div className="mt-3">
              {demo ? (
                <Button
                  onClick={() => {
                    onLeaveDemo();
                    setOpen(false);
                  }}
                >
                  Leave demo mode
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    onEnterDemo();
                    setOpen(false);
                  }}
                >
                  Enter demo mode
                </Button>
              )}
            </div>
          </div>
          {/* There are two stores and this button empties exactly one of them,
              so it says which. While demo mode is on it is the demo store: the
              live readings are behind the fixtures on screen, and a control
              that emptied them would show no visible change at all. */}
          <div className="border-t border-hairline px-3 py-3">
            <p className="ol-brand-font text-sm text-heading">
              {demo ? "Stored demo readings" : "Stored readings"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {demo
                ? "Forgets the synthetic fixtures only. Your own readings are in a separate store and are not touched by this."
                : "Forgets what this browser kept. It cannot reach a provider, so nothing anywhere else changes."}
            </p>
            <div className="mt-3">
              <Button
                tone="quiet"
                disabled={!clearable}
                title={
                  demo
                    ? "Clears the demo store only. The live store is left exactly as it is."
                    : "Clears the live store only. The demo fixtures are left exactly as they are."
                }
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
              >
                {demo ? "Clear demo readings" : "Clear live readings"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ shells */

export function Panel({
  title,
  description,
  children,
  action,
  demo = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  action?: ReactNode;
  demo?: boolean;
}) {
  return (
    <section data-demo={demo ? "" : undefined} className={`ol-rise ${CARD_SURFACE}`}>
      {demo && <DemoStrip className="" />}
      <div className="p-5 sm:p-6">
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
      </div>
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
  title,
  className = "",
  children,
}: {
  tone?: keyof typeof buttonTone;
  onClick: () => void;
  disabled?: boolean;
  /** Accessible name, for a control whose text alone is not enough. */
  label?: string;
  /**
   * What the control actually does, when its own words cannot carry all of it.
   *
   * Separate from `label` on purpose: `label` replaces the accessible name and
   * belongs on a control with no text, while this adds an explanation to one
   * whose text is already correct. Every honesty note about what a button does
   * and does not reach uses this.
   */
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const naming = label === undefined ? {} : { "aria-label": label, title: label };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...(title === undefined ? {} : { title })}
      {...naming}
      className={`${buttonBase} ${buttonTone[tone]} ${className}`}
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

/**
 * A block exactly as something else would receive it.
 *
 * The `<pre>` is bit exact and stays that way. When the readings behind it are
 * synthetic the warning goes in the chrome around the block, never inside it,
 * because the whole value of this view is that what you copy is what the hook
 * injects, character for character.
 */
export function CodeBlock({
  text,
  label,
  synthetic = false,
}: {
  text: string;
  label: string;
  synthetic?: boolean;
}) {
  return (
    <figure>
      <figcaption className="mb-2 flex flex-wrap items-center gap-2 text-2xs uppercase tracking-widest text-muted">
        {label}
        {synthetic && (
          <span className="ol-demo-inline">
            <span aria-hidden="true" className="ol-demo-dot" />
            Built from demo data
          </span>
        )}
      </figcaption>
      <pre className="overflow-x-auto rounded-lg border border-hairline bg-code p-4 font-mono text-xs leading-relaxed text-body">
        <code>{text}</code>
      </pre>
    </figure>
  );
}
