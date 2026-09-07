"use client";

import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  PROVIDER_ROW_TAG,
  buildProviderDirectory,
  defineProviderRowElement,
  setProviderRowData,
  type ProviderAccountRowView,
  type ProviderDirectoryRow,
} from "./engine";
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
  const visibleRows = rows.filter((row) => row.windows.length > 0);
  return (
    <div aria-label="Provider usage by account" className="ol-telemetry-table">
      <div role="list" className="ol-provider-row-list">
        {visibleRows.map((row) => (
          <div role="listitem" key={row.key} className="ol-rise">
            <ProviderAccountRow row={row} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * One dollar reading, drawn the one way this product draws money.
 *
 * The paired phone's meters and the hub's cloud metered spend rows are the
 * same fact in two places: a name, an amount, and whether the amount is
 * still fresh. Both draw this component rather than keeping their own copy,
 * so a dollar figure looks like the same dollar figure everywhere it appears.
 * `icon` is optional because a phone's provider code needs none; the cloud
 * rows carry one to say plainly where the reading came from.
 */
export function DollarRow({
  icon,
  name,
  amountText,
  stale,
}: {
  icon?: ReactNode;
  name: ReactNode;
  amountText: string;
  stale: boolean;
}) {
  return (
    <div className="ol-device-money-row">
      <span className="ol-device-money-name">
        {icon}
        {name}
      </span>
      <span className="ol-device-money-value" data-state={stale ? "stale" : "fresh"}>
        {amountText}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

/**
 * The strip above the cards, which is this application's own title bar.
 *
 * The lockup uses the canonical gauge and system wordmark at the same
 * proportion as the site header. The other side holds actions only. Quota
 * facts belong to the provider window rows below.
 */
export function HeaderStrip({
  lockup,
  busy,
  onRefresh,
  accent,
  actions,
  showRefresh = true,
}: {
  lockup: ReactNode;
  busy: boolean;
  onRefresh: () => void;
  /**
   * The one accent control, kept beside the logo rather than lumped in with
   * the icon group.
   *
   * Below 800 px the strip already breaks onto two rows; without a place of
   * its own the accent button used to fall in with every icon after it, and
   * at 375 px that whole row ran out of space and wrapped again, three rows
   * instead of two. Giving it a fixed seat on the logo's own row is what
   * keeps the icon group and Sync to the one row meant for them.
   */
  accent?: ReactNode;
  actions?: ReactNode;
  showRefresh?: boolean;
}) {
  return (
    <section
      aria-label="Application controls"
      className="ol-rise ol-commandbar"
    >
      <div className="ol-commandbar-main">
        <div className="ol-commandbar-brand-row">
          <div className="ol-commandbar-brand">{lockup}</div>
          {accent}
        </div>
        <div className="ol-commandbar-actions">
          {actions}
          {showRefresh && (
            <Button
              tone="ghost"
              onClick={onRefresh}
              disabled={busy}
              label="Sync"
              title="Reads synced data again."
            >
              <RefreshGlyph spinning={busy} />
              <span className="ol-sync-label">Sync</span>
            </Button>
          )}
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

/* ------------------------------------------------------------ icon controls */

/**
 * A square control holding one glyph, at the header's own metrics.
 *
 * It always carries a name, because it never carries text: the gear beside the
 * bars is the only way into configuration, and a control whose only label is a
 * picture is invisible to anyone who cannot see the picture.
 */
export function IconButton({
  label,
  onClick,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  /** For a control that toggles a view rather than performing an action. */
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      onClick={onClick}
      className="ol-icon-control ol-tap focus-ring"
    >
      {children}
    </button>
  );
}

export function GearGlyph() {
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
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function PlusGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function BackGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 5l-7 7 7 7" />
    </svg>
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

/* ---------------------------------------------------------- provider directory */

export const BROWSER_PROVIDER_STATES = {
  claude: "IMPORT_ONLY",
  codex: "IMPORT_ONLY",
  openrouter: "IMPORT_ONLY",
  antigravity: "IMPORT_ONLY",
  "gemini-cli": "IMPORT_ONLY",
  opencode: "IMPORT_ONLY",
  grok: "IMPORT_ONLY",
  kimi: "IMPORT_ONLY",
} as const;

export function providerMarkCode(row: ProviderDirectoryRow): string {
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

function MenuGlyph() {
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
      <path d="M4 7h16M4 12h16M4 17h16" />
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
  accountEmail,
  syncEnabled,
  onSyncChange,
  onCheckUpdate,
  onLogout,
}: {
  accountEmail: string;
  syncEnabled: boolean;
  onSyncChange: (enabled: boolean) => void;
  onCheckUpdate: () => void;
  onLogout: () => void;
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
        aria-label="Open menu"
        title="Open menu"
        onClick={() => {
          setOpen((current) => !current);
        }}
        className={`ol-tap focus-ring inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-hairline-strong text-heading hover:border-heading hover:bg-surface ${
          open ? "bg-surface" : "bg-transparent"
        }`}
      >
        <MenuGlyph />
      </button>

      {open && (
        <div className="ol-menu" role="group" aria-label="Account menu">
          <div className="px-3 py-3">
            <p className="ol-brand-font text-sm text-heading">{accountEmail}</p>
          </div>
          <label className="ol-menu-toggle border-t border-hairline px-3 py-3">
            <span>Sync usage percentages</span>
            <input
              type="checkbox"
              checked={syncEnabled}
              onChange={(event) => onSyncChange(event.target.checked)}
            />
          </label>
          <div className="grid gap-2 border-t border-hairline px-3 py-3">
            <Button onClick={onCheckUpdate}>Check for updates</Button>
            <Link className="ol-menu-link focus-ring" href="/en/docs">About OpenLimiter</Link>
            <Button tone="quiet" onClick={onLogout}>Log out</Button>
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
  /* An explicit title always wins: it is a fuller sentence the label is not
     meant to replace. Only when there is no title does the label double as
     one, which keeps every call site that passes label alone unchanged. */
  const naming: Record<string, string> = {};
  if (label !== undefined) naming["aria-label"] = label;
  if (title !== undefined) naming.title = title;
  else if (label !== undefined) naming.title = label;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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
