"use client";

import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import {
  PROVIDER_ROW_TAG,
  buildProviderDirectory,
  defineProviderRowElement,
  setProviderRowData,
  type Advice,
  type ProviderAccountRowView,
  type ProviderDirectoryRow,
} from "./engine";
import {
  reasonPressure,
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

/* ------------------------------------------------------------------ shapes */

const CARD_SURFACE = "ol-product-panel";

/** The site's chip: a pill, a hairline, twelve pixel text. */
const CHIP = "ol-chip inline-flex items-center gap-2 border px-2.5 py-1 text-xs";

const CHIP_STRONG = `${CHIP} border-hairline bg-raised text-heading`;
const CHIP_ACCENT = `${CHIP} border-accent-subtle bg-accent-subtle text-accent`;

export function ProviderAccountRow({ row }: { row: ProviderAccountRowView }) {
  const host = useRef<HTMLElement | null>(null);

  useEffect(() => {
    defineProviderRowElement();
    if (host.current !== null) setProviderRowData(host.current, row);
  }, [row]);

  return createElement(PROVIDER_ROW_TAG, {
    ref: (element: HTMLElement | null) => {
      host.current = element;
    },
    "data-row-key": row.key,
    suppressHydrationWarning: true,
  });
}

export function ProviderRows({ rows }: { rows: readonly ProviderAccountRowView[] }) {
  return (
    <div role="list" aria-label="Provider usage by account" className="ol-telemetry-table">
      {rows.map((row) => (
        <div role="listitem" key={row.key} className="ol-rise">
          <ProviderAccountRow row={row} />
        </div>
      ))}
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
      className="ol-rise ol-commandbar"
    >
      {demo && <DemoStrip className="" />}
      <div className="ol-commandbar-main">
        <div className="ol-commandbar-brand">{lockup}</div>
        <div className="ol-commandbar-state">
          <span className="ol-live-chip">
            <span aria-hidden="true" className="ol-live-dot" />
            {busy ? "Reading" : "Live"}
          </span>
          <span className={CHIP_STRONG}>
            <span aria-hidden="true" data-pressure={pressure} className="ol-pressure-dot" />
            <span className="font-mono tracking-widest">{reason}</span>
          </span>
          {recommendation !== null && recommendation.code === "PREFER" && (
            <span className={CHIP_ACCENT} title="Preferred provider">
              <span className="font-mono tracking-widest">
                Next {recommendation.provider}
              </span>
            </span>
          )}
          <span className="ol-updated font-mono">
            {asOf === null ? "Waiting" : asOf}
          </span>
          {demo && <DemoDataChip />}
        </div>
        <div className="ol-commandbar-actions">
          {actions}
          <Button
            tone="ghost"
            onClick={onRefresh}
            disabled={busy}
            title="Reads stored data on this device."
          >
            <RefreshGlyph spinning={busy} />
            Sync
          </Button>
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
      className="ol-product-tabs"
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
            data-selected={selected ? "" : undefined}
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
            className="ol-product-tab ol-tap focus-ring-inset"
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------- skeletons */

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div aria-hidden="true" className="ol-telemetry-table">
      {Array.from({ length: count }, (_unused, index) => (
        <div
          key={"row-skeleton" + String(index)}
          className="ol-row-skeleton"
        >
          <div className="ol-row-skeleton-identity">
            <span className="ol-skeleton block h-8 w-8" />
            <span className="space-y-2">
              <span className="ol-skeleton block h-3 w-24" />
              <span className="ol-skeleton block h-2 w-16" />
            </span>
          </div>
          <div className="ol-row-skeleton-windows">
            {[0, 1].map((window) => (
              <span key={"window-skeleton" + String(window)} className="space-y-2">
                <span className="ol-skeleton block h-2.5 w-20" />
                <span className="ol-skeleton block h-3 w-16" />
                <span className="ol-skeleton block h-1.5 w-full" />
              </span>
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
 * So the first launch keeps one calm action above the honest fallback rows.
 */
export function FirstRunState({ onConnect }: { onConnect: () => void }) {
  return (
    <section className="ol-rise ol-empty-row">
      <div className="ol-empty-identity">
        <span aria-hidden="true" className="ol-empty-mark">
          <PlugGlyph />
        </span>
        <div>
          <h3 className="ol-brand-font">No live accounts</h3>
          <p>Connect a provider to begin.</p>
        </div>
      </div>
      <Button tone="primary" onClick={onConnect}>
        Add account
      </Button>
    </section>
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

/* ---------------------------------------------------------- provider directory */

const BROWSER_PROVIDER_STATES = {
  claude: "IMPORT_ONLY",
  codex: "IMPORT_ONLY",
  openrouter: "IMPORT_ONLY",
  antigravity: "IMPORT_ONLY",
  "gemini-cli": "IMPORT_ONLY",
  opencode: "IMPORT_ONLY",
  grok: "IMPORT_ONLY",
  kimi: "IMPORT_ONLY",
} as const;

function providerMarkCode(row: ProviderDirectoryRow): string {
  return (row.connectorId ?? row.specId).toUpperCase().replaceAll("-", "_");
}

function DirectoryGroup({
  availability,
  label,
  note,
  rows,
  onConnect,
  onManual,
}: {
  availability: ProviderDirectoryRow["availability"];
  label: string;
  note: string;
  rows: readonly ProviderDirectoryRow[];
  onConnect: (row: ProviderDirectoryRow) => void;
  onManual: (row: ProviderDirectoryRow) => void;
}) {
  return (
    <section
      className="ol-directory-group"
      data-availability={availability}
      aria-labelledby={`directory-${availability}`}
    >
      <header className="ol-directory-group-head">
        <div className="ol-directory-group-copy">
          <h3 id={`directory-${availability}`}>{label}</h3>
          <p>{note}</p>
        </div>
        <span className="ol-directory-group-count">{rows.length}</span>
      </header>
      <ul className="ol-directory-list">
        {rows.map((row) => (
          <li
            key={row.key}
            className="ol-directory-row"
            data-access={row.access}
            data-availability={row.availability}
          >
            <div className="ol-directory-identity">
              <span className="ol-provider-mark" data-provider={providerMarkCode(row)}>
                <ProviderMark provider={providerMarkCode(row)} label={row.displayName} />
              </span>
              <span className="ol-directory-name">
                <strong>{row.displayName}</strong>
                <span>{row.description}</span>
              </span>
            </div>
            <span className="ol-directory-access" data-access={row.access}>
              {row.accessLabel}
            </span>
            <span className="ol-directory-state" data-tone={row.stateTone}>
              <span aria-hidden="true" />
              {row.stateLabel}
            </span>
            {row.actionLabel !== null && (
              <Button
                tone={row.access === "key" && row.availability === "ready" ? "primary" : "ghost"}
                onClick={() => {
                  if (row.action === "manual") onManual(row);
                  else onConnect(row);
                }}
                className="ol-directory-action"
              >
                {row.actionLabel}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ProviderDirectory({
  onConnect,
  onManual,
  onEnterDemo,
}: {
  onConnect: (row: ProviderDirectoryRow) => void;
  onManual: (row: ProviderDirectoryRow) => void;
  onEnterDemo?: () => void;
}) {
  const rows = buildProviderDirectory(registry, { states: BROWSER_PROVIDER_STATES });
  const ready = rows.filter((row) => row.availability === "ready");
  const planned = rows.filter((row) => row.availability === "planned");

  return (
    <div id="provider-directory" className="ol-provider-directory">
      <DirectoryGroup
        availability="ready"
        label="Available now"
        note="Supported here. Your account is verified only after a live read."
        rows={ready}
        onConnect={onConnect}
        onManual={onManual}
      />
      <DirectoryGroup
        availability="planned"
        label="Roadmap"
        note="Not built yet. No setup required."
        rows={planned}
        onConnect={onConnect}
        onManual={onManual}
      />
      {onEnterDemo && (
        <div className="ol-directory-demo">
          <span>Preview every meter</span>
          <Button tone="ghost" onClick={onEnterDemo}>Demo</Button>
        </div>
      )}
    </div>
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
      Demo
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
        <span className="ol-demo-banner-detail">Sample readings only.</span>
      </p>
      <Button tone="ghost" onClick={onLeave} className="flex-none">
        Exit demo
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
      <div className="ol-product-panel-inner">
        <div className="ol-product-panel-head">
          <div>
            <h2 className="ol-brand-font">{title}</h2>
            {description !== undefined && (
              <p>{description}</p>
            )}
          </div>
          {action}
        </div>
        <div className="ol-product-panel-body">{children}</div>
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
  "ol-control ol-tap focus-ring inline-flex cursor-pointer items-center justify-center gap-2 border text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50";

const buttonTone = {
  primary: "ol-control-primary",
  ghost: "ol-control-ghost",
  quiet: "ol-control-quiet",
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
    <span className="ol-chip inline-flex items-center gap-1.5 border border-hairline bg-raised px-2 py-1 font-mono text-2xs uppercase tracking-wider text-muted">
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
      <pre className="ol-code-block overflow-x-auto border border-hairline bg-code p-4 font-mono text-xs leading-relaxed text-body">
        <code>{text}</code>
      </pre>
    </figure>
  );
}
